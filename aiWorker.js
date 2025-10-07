// aiWorker.js (ES module)
import * as G from './Worker_utils.js';

const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const SCORE = {
    FIVE: 10000000,
    OPEN_FOUR: 200000,
    FOUR: 40000,
    OPEN_THREE: 8000,
    THREE: 2000,
    OPEN_TWO: 200,
    TWO: 20,
    ONE: 1
};

const PATTERN_SCORES = {
    JUMP_THREE: SCORE.THREE * 2,
};

const BONUS = {
    FORK: Math.floor(SCORE.OPEN_FOUR * 5),
    SINGLE_OPEN_FOUR: Math.floor(SCORE.OPEN_FOUR * 3),
    DOUBLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 12),
    SINGLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 3)
};

// state object
let state = {
    board: null,
    zobrist: null,
    currentHash: 0,
    history: []
};

let settings = null;
let playerColor = null;
let aiColor = null;

let nodesGlobal = 0;
let lastReportTime = 0;
let lastReportNodes = 0;

const REPORT_NODES = 500;
const REPORT_MS = 100;

// small local now() wrapper (kept local for slight speed)
function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

onmessage = (e) => {
    const data = e.data;
    if (!data || data.cmd !== 'think') return;

    state.board = G.deepCopyBoard(data.board);
    settings = data.settings || { radius: 2, timeLimit: 1200, minDepth: 3, maxQuiescenceDepth: 8 };
    playerColor = data.playerColor;
    aiColor = data.aiColor;
    state.history = data.history ? JSON.parse(JSON.stringify(data.history)) : [];

    nodesGlobal = 0;
    lastReportTime = now();
    lastReportNodes = 0;

    try {
        const result = runAI();
        postMessage({ cmd: 'result', bestMove: result.bestMove, depth: result.depth, nodes: result.nodes, elapsed: result.elapsed, eval: result.bestScore });
    } catch (err) {
        postMessage({ cmd: 'error', message: String(err) });
    }
};

// ----------------- Zobrist / TT / キャッシュ -----------------
let transpositionTable = null;
let evalCache = null;

function initZobrist() {
    state.zobrist = G.createZobrist(BOARD_SIZE);
    transpositionTable = new Map();
}

function computeHashFromBoardLocal() {
    state.currentHash = G.computeHashFromBoard(state.board, state.zobrist);
    return state.currentHash;
}

// ----------------- push/pop moved into worker (state mutation, optimized) -----------------
function pushMove(stateObj, x, y, player) {
    stateObj.board[y][x] = player;
    stateObj.history.push({ x, y, player });
    // update hash by xor
    stateObj.currentHash = (stateObj.currentHash ^ stateObj.zobrist[y][x][player]) >>> 0;
}

function popMove(stateObj) {
    const last = stateObj.history.pop();
    if (!last) return null;
    stateObj.board[last.y][last.x] = EMPTY;
    stateObj.currentHash = (stateObj.currentHash ^ stateObj.zobrist[last.y][last.x][last.player]) >>> 0;
    return last;
}

function makeMoveHash(x, y, player, hist) { // kept signature for compatibility
    pushMove(state, x, y, player);
}
function undoMoveHash(hist) {
    return popMove(state);
}

// ----------------- Candidate & evaluation wrappers -----------------
function generateCandidatesFromHistory(hist, radius) {
    // delegate to pure util; hist may be provided or use state.history
    return G.generateCandidatesFromHistory(state.board, hist || state.history, radius, BOARD_SIZE);
}

function evaluateLineLocal(lineArr, player) {
    return G.evaluateLineArr(lineArr, player);
}

function evaluateBoardLocal(player, b) {
    return G.evaluateBoard(b, player);
}

function checkWinLocal(x,y,player,b) {
    return G.checkWin(b, x, y, player, BOARD_SIZE);
}

// ----------------- getImmediateWinningMoves / getOpenThreeMoves moved into worker and optimized -----------------
function getImmediateWinningMovesLocal(player, b, hist, radius) {
    const useHist = hist || state.history;
    const cacheKey = `${state.currentHash}:imwin:${player}:r${radius}:h${useHist.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();

    const wins = [];
    const candidates = G.generateCandidatesFromHistory(b, useHist, radius, b.length);
    const boardLocal = b;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const x = c.x, y = c.y;
        if (boardLocal[y][x] !== EMPTY) continue;
        pushMove(state, x, y, player);
        try {
            if (G.checkWin(boardLocal, x, y, player, b.length)) wins.push({ x, y });
        } finally {
            popMove(state);
        }
    }

    evalCache.set(cacheKey, wins.slice());
    return wins;
}

// getOpenThreeMovesLocal — optimized: reuse small buffer to avoid repeated allocations
function getOpenThreeMovesLocal(player, b, hist, radius) {
    const useHist = hist || state.history;
    const cacheKey = `${state.currentHash}:openthree:${player}:r${radius}:h${useHist.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();

    const moves = [];
    const boardLocal = b;
    const boardSize = b.length;
    const opponent = player === BLACK ? WHITE : BLACK;

    const candidates = G.generateCandidatesFromHistory(boardLocal, useHist, radius, boardSize);
    const directions = [[1,0],[0,1],[1,1],[1,-1]];
    const lineBuf = new Array(11); // reuse buffer for -5..+5

    for (let idx = 0; idx < candidates.length; idx++) {
        const c = candidates[idx];
        const x = c.x, y = c.y;
        if (boardLocal[y][x] !== EMPTY) continue;

        pushMove(state, x, y, player);
        let hasOpenThree = false;
        try {
            for (let d = 0; d < 4; d++) {
                const dx = directions[d][0], dy = directions[d][1];
                // fill buffer
                for (let i = -5, bi = 0; i <= 5; i++, bi++) {
                    const nx = x + i*dx, ny = y + i*dy;
                    lineBuf[bi] = (nx >= 0 && nx < boardSize && ny >= 0 && ny < boardSize) ? boardLocal[ny][nx] : 3;
                }
                // check 5-window open three
                for (let s = 0; s + 5 <= 11; s++) {
                    if (lineBuf[s] === EMPTY && lineBuf[s+1] === player && lineBuf[s+2] === player && lineBuf[s+3] === player && lineBuf[s+4] === EMPTY) {
                        hasOpenThree = true; break;
                    }
                }
                if (hasOpenThree) break;
                // check 6-window jump three patterns
                for (let s = 0; s + 6 <= 11; s++) {
                    const w0 = lineBuf[s], w1 = lineBuf[s+1], w2 = lineBuf[s+2], w3 = lineBuf[s+3], w4 = lineBuf[s+4], w5 = lineBuf[s+5];
                    if ((w0 === EMPTY && w1 === player && w2 === EMPTY && w3 === player && w4 === player && w5 === EMPTY) ||
                        (w0 === EMPTY && w1 === player && w2 === player && w3 === EMPTY && w4 === player && w5 === EMPTY)) {
                        hasOpenThree = true; break;
                    }
                }
                if (hasOpenThree) break;
            }
        } finally {
            popMove(state);
        }

        if (hasOpenThree) moves.push({ x, y });
    }

    evalCache.set(cacheKey, moves.slice());
    return moves;
}

// ----------------- getMoveScoreLocal (最適化: line buffer reuse) -----------------
function getMoveScoreLocal(x, y, player, b) {
    const cacheKey = `${state.currentHash}:movescore:${player}:${x},${y}:h${state.history.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey);

    let score = 0;
    const directions = [[1,0],[0,1],[1,1],[1,-1]];
    const lineBuf = new Array(9); // -4..+4

    makeMoveHash(x, y, player, state.history);
    try {
        const boardLocal = state.board;
        const bs = boardLocal.length;
        for (let d = 0; d < 4; d++) {
            const dx = directions[d][0], dy = directions[d][1];
            for (let i = -4, bi = 0; i <= 4; i++, bi++) {
                const nx = x + i*dx, ny = y + i*dy;
                lineBuf[bi] = (nx >= 0 && nx < bs && ny >= 0 && ny < bs) ? boardLocal[ny][nx] : 3;
            }
            score += evaluateLineLocal(lineBuf, player);
        }
    } finally {
        undoMoveHash(state.history);
    }

    evalCache.set(cacheKey, score);
    return score;
}

// ----------------- generateMoves / generateRootCandidates (小最適化: key encoding) -----------------
function generateMovesLocal(player, b, hist, radius, limit = 30) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const candidates = generateCandidatesFromHistory(hist, radius);
    const scoredMoves = [];

    const myWins = getImmediateWinningMovesLocal(player, b, hist, radius);
    if (myWins.length > 0) {
        return myWins.map(m => ({ x: m.x, y: m.y, score: SCORE.FIVE }));
    }

    const oppWins = getImmediateWinningMovesLocal(opponent, b, hist, radius);
    if (oppWins.length > 0) {
        if (oppWins.length === 1) {
            const blockMove = oppWins[0];
            return [{ x: blockMove.x, y: blockMove.y, score: SCORE.OPEN_FOUR * 2 }];
        }
        for (let i = 0; i < oppWins.length; i++) candidates.unshift({ x: oppWins[i].x, y: oppWins[i].y });
    }

    const seen = new Set();
    const boardLocal = b;
    const bs = BOARD_SIZE;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const key = c.x * bs + c.y;
        if (seen.has(key)) continue;
        seen.add(key);
        if (boardLocal[c.y][c.x] !== EMPTY) continue;

        const attackScore = getMoveScoreLocal(c.x, c.y, player, b);
        const defenseScore = getMoveScoreLocal(c.x, c.y, opponent, b);

        let totalScore = attackScore + defenseScore;
        if (attackScore >= SCORE.OPEN_THREE) totalScore += attackScore;
        if (defenseScore >= SCORE.OPEN_THREE) totalScore += defenseScore;

        scoredMoves.push({ x: c.x, y: c.y, score: totalScore });
    }

    scoredMoves.sort((a, b) => b.score - a.score);
    if (scoredMoves.length > limit) scoredMoves.length = limit;
    return scoredMoves;
}

function generateRootCandidates(player, b, hist, radius) {
    const raw = generateMovesLocal(player, b, hist, radius, 80);
    const scored = [];
    for (let i = 0; i < raw.length; i++) {
        const mv = raw[i];
        const s = getMoveScoreLocal(mv.x, mv.y, player, b);
        scored.push({ x: mv.x, y: mv.y, score: s });
    }
    scored.sort((a,b) => b.score - a.score);
    // return shallow map
    const out = new Array(scored.length);
    for (let i = 0; i < scored.length; i++) out[i] = { x: scored[i].x, y: scored[i].y, score: scored[i].score };
    return out;
}

// ----------------- report -----------------
function maybeReport(extra = {}) {
    const t = now();
    const nodesSince = nodesGlobal - lastReportNodes;
    if (nodesSince >= REPORT_NODES || (t - lastReportTime) >= REPORT_MS) {
        lastReportTime = t;
        lastReportNodes = nodesGlobal;
        const elapsed = t - startTimeGlobal;
        const nps = (nodesGlobal / Math.max(0.001, elapsed / 1000));
        postMessage(Object.assign({ cmd: 'progress', depth: currentDepthGlobal, elapsed, nodes: nodesGlobal, nps, candidate: currentCandidateGlobal, eval: currentEvalGlobal, log: null }, extra));
    }
}

let startTimeGlobal = 0;
let currentDepthGlobal = 0;
let currentCandidateGlobal = '—';
let currentEvalGlobal = 0;

// ----------------- Quiescence (小最適化: key encoding) -----------------
function quiescence(player, alpha, beta, b, hist, radius, qDepth) {
    if (qDepth <= 0) return evaluateBoardLocal(player, b);

    const timeLimit = Math.max(50, settings.timeLimit || 1200);
    if ((now() - startTimeGlobal) > timeLimit) return evaluateBoardLocal(player, b);

    nodesGlobal++;
    maybeReport();

    const myWins = getImmediateWinningMovesLocal(player, b, hist, radius);
    if (myWins.length > 0) {
        return SCORE.FIVE;
    }

    const stand_pat = evaluateBoardLocal(player, b);
    if (stand_pat >= beta) return stand_pat;
    if (alpha < stand_pat) alpha = stand_pat;

    const moves = [];
    const opponent = player === BLACK ? WHITE : BLACK;

    const oppWins = getImmediateWinningMovesLocal(opponent, b, hist, radius);
    for (let i = 0; i < oppWins.length; i++) moves.push({x:oppWins[i].x,y:oppWins[i].y,score: Math.floor(SCORE.OPEN_FOUR * 3)});

    const myOpenThrees = getOpenThreeMovesLocal(player, b, hist, radius);
    for (let i = 0; i < myOpenThrees.length; i++) moves.push({x:myOpenThrees[i].x,y:myOpenThrees[i].y,score: BONUS.SINGLE_OPEN_THREE});

    const oppOpenThrees = getOpenThreeMovesLocal(opponent, b, hist, radius);
    for (let i = 0; i < oppOpenThrees.length; i++) moves.push({x:oppOpenThrees[i].x,y:oppOpenThrees[i].y,score: Math.floor(SCORE.OPEN_THREE * 2)});

    moves.sort((a,b)=> b.score - a.score);

    const seen = new Set();
    const bs = BOARD_SIZE;
    for (let i = 0; i < moves.length; i++) {
        const mv = moves[i];
        const key = mv.x * bs + mv.y;
        if (seen.has(key) || b[mv.y][mv.x] !== EMPTY) continue;
        seen.add(key);

        makeMoveHash(mv.x, mv.y, player, hist);
        try {
            const score = -quiescence(opponent, -beta, -alpha, b, hist, radius, qDepth - 1);
            if (score >= beta) return score;
            if (score > alpha) alpha = score;
        } finally {
            undoMoveHash(hist);
        }
    }

    return alpha;
}

// ----------------- negamax (PVS) -----------------
function negamax(depth, alpha, beta, player, b, hist, radius) {
    nodesGlobal++;
    maybeReport();

    const ttKey = `${state.currentHash}:${depth}:${player}`;
    const ttEntry = transpositionTable.get(ttKey);
    if (ttEntry && ttEntry.depth >= depth) {
        if (ttEntry.flag === 'EXACT') return { score: ttEntry.score, nodes: 1 };
        if (ttEntry.flag === 'LOWER' && ttEntry.score > alpha) alpha = ttEntry.score;
        if (ttEntry.flag === 'UPPER' && ttEntry.score < beta) beta = ttEntry.score;
        if (alpha >= beta) return { score: ttEntry.score, nodes: 1 };
    }

    if (depth <= 0) {
        const maxQ = Math.max(1, (settings.maxQuiescenceDepth || 6));
        const q = quiescence(player, alpha, beta, b, hist, radius, maxQ);
        transpositionTable.set(ttKey, { score: q, depth: 0, flag: 'EXACT' });
        return { score: q, nodes: 1 };
    }

    let bestScore = -Infinity;
    let nodes = 0;
    let moves = generateMovesLocal(player, b, hist, radius);
    if (moves.length === 0) {
        const val = evaluateBoardLocal(player, b);
        transpositionTable.set(ttKey, { score: val, depth, flag: 'EXACT' });
        return { score: val, nodes: 1 };
    }

    // TT best ordering
    const ttBest = ttEntry && ttEntry.bestMove ? ttEntry.bestMove : null;
    if (ttBest) {
        const idx = moves.findIndex(m => m.x === ttBest.x && m.y === ttBest.y);
        if (idx > 0) {
            const m = moves.splice(idx,1)[0];
            moves.unshift(m);
        }
    }

    // limit branching
    let maxMoves;
    if (depth >= 6) maxMoves = 10;
    else if (depth >= 4) maxMoves = 18;
    else maxMoves = 30;
    if (moves.length > maxMoves) moves.length = maxMoves;

    const origAlpha = alpha;
    let bestMoveLocal = null;

    let isFirst = true;
    const opponent = (player === BLACK) ? WHITE : BLACK;

    for (let i = 0; i < moves.length; i++) {
        const mv = moves[i];
        makeMoveHash(mv.x, mv.y, player, hist);

        let childRes;
        let score;
        if (isFirst) {
            childRes = negamax(depth - 1, -beta, -alpha, opponent, b, hist, radius);
            nodes += childRes.nodes;
            score = -childRes.score;
        } else {
            // null window
            childRes = negamax(depth - 1, -alpha - 1, -alpha, opponent, b, hist, radius);
            nodes += childRes.nodes;
            score = -childRes.score;
            if (score > alpha && score < beta) {
                const re = negamax(depth - 1, -beta, -alpha, opponent, b, hist, radius);
                nodes += re.nodes;
                score = -re.score;
            }
        }

        undoMoveHash(hist);

        if (score > bestScore) {
            bestScore = score;
            bestMoveLocal = { x: mv.x, y: mv.y };
        }

        if (score > alpha) alpha = score;
        if (alpha >= beta) {
            // beta cutoff
            break;
        }
        isFirst = false;
    }

    let flag = 'EXACT';
    if (bestScore <= origAlpha) flag = 'UPPER';
    else if (bestScore >= beta) flag = 'LOWER';
    transpositionTable.set(ttKey, { score: bestScore, depth, flag, bestMove: bestMoveLocal });

    return { score: bestScore, nodes: nodes + 1 };
}

// ----------------- runAI (Aspiration Window) -----------------
function runAI() {
    initZobrist();
    computeHashFromBoardLocal();
    transpositionTable.clear();
    evalCache = new Map();

    startTimeGlobal = now();
    nodesGlobal = 0;
    lastReportTime = startTimeGlobal;
    lastReportNodes = 0;
    currentDepthGlobal = 0;
    currentCandidateGlobal = '—';
    currentEvalGlobal = 0;

    const timeLimit = Math.max(50, settings.timeLimit || 1200);
    const minDepth = Math.max(1, settings.minDepth || 1);
    const radius = Math.max(1, settings.radius || 2);

    const ASPIRATION_DELTA = typeof settings.aspirationDelta === 'number' ? settings.aspirationDelta : 2000;

    // short-circuit checks
    const cpuImmediate = getImmediateWinningMovesLocal(aiColor, state.board, state.history, radius);
    if (cpuImmediate.length > 0) {
        postMessage({ cmd: 'progress', log: '発見: CPU 即勝' });
        return { bestMove: cpuImmediate[0], depth: 0, nodes: 1, elapsed: now()-startTimeGlobal, bestScore: SCORE.FIVE };
    }
    const oppImmediate = getImmediateWinningMovesLocal(playerColor, state.board, state.history, radius);
    if (oppImmediate.length > 0) {
        if (oppImmediate.length === 1) {
            const block = oppImmediate[0];
            postMessage({ cmd: 'progress', log: '発見: 相手 単一即勝 -> ブロック' });
            return { bestMove: block, depth: 0, nodes: 1, elapsed: now()-startTimeGlobal, bestScore: SCORE.OPEN_FOUR * 2 };
        } else {
            postMessage({ cmd: 'progress', log: '警告: 相手に複数の即勝手あり' });
        }
    }

    // iterative deepening with aspiration
    let bestMove = null;
    let bestScore = -Infinity;
    let depth = 1;
    const MAX_SEARCH_DEPTH = 12;

    const rootCandidates = generateRootCandidates(aiColor, state.board, state.history, radius);
    if (rootCandidates.length === 0) {
        return { bestMove: null, depth:0, nodes:0, elapsed: now()-startTimeGlobal, bestScore: 0 };
    }
    bestMove = { x: rootCandidates[0].x, y: rootCandidates[0].y };

    while (true) {
        currentDepthGlobal = depth;
        const elapsed = now() - startTimeGlobal;
        if (elapsed > timeLimit && depth > minDepth) break;
        if (depth > MAX_SEARCH_DEPTH) break;

        let alpha = -Infinity, beta = Infinity;
        if (depth > 1 && Number.isFinite(bestScore)) {
            alpha = bestScore - ASPIRATION_DELTA;
            beta = bestScore + ASPIRATION_DELTA;
        }

        let bestScoreThisDepth = -Infinity;
        let bestMoveThisDepth = null;

        const searchOnce = (alphaIn, betaIn) => {
            let localBestScore = -Infinity;
            let localBestMove = null;
            // limit root branching to reasonable number to bound search
            const maxRootMoves = 40;
            const moves = rootCandidates.slice(0, Math.min(rootCandidates.length, maxRootMoves));
            for (let i = 0; i < moves.length; i++) {
                const cand = moves[i];
                currentCandidateGlobal = `(${cand.x},${cand.y})`;
                makeMoveHash(cand.x, cand.y, aiColor, state.history);

                const res = negamax(depth - 1, -betaIn, -alphaIn, playerColor, state.board, state.history, radius);

                undoMoveHash(state.history);

                const score = -res.score;
                if (score > localBestScore) {
                    localBestScore = score;
                    localBestMove = { x: cand.x, y: cand.y };
                    alphaIn = Math.max(alphaIn, localBestScore);
                    currentEvalGlobal = localBestScore;
                }

                maybeReport({ log: `深さ${depth} 候補 ${currentCandidateGlobal} 評価 ${score}` });

                if (now() - startTimeGlobal > timeLimit && depth > minDepth) break;
            }
            return { localBestScore, localBestMove };
        };

        const initial = searchOnce(alpha, beta);
        bestScoreThisDepth = initial.localBestScore;
        bestMoveThisDepth = initial.localBestMove;

        if (bestScoreThisDepth <= alpha || bestScoreThisDepth >= beta) {
            // fail low/high -> full window
            const full = searchOnce(-Infinity, Infinity);
            bestScoreThisDepth = full.localBestScore;
            bestMoveThisDepth = full.localBestMove;
        }

        if (bestMoveThisDepth) {
            bestMove = bestMoveThisDepth;
            bestScore = bestScoreThisDepth;

            const idx = rootCandidates.findIndex(c => c.x === bestMove.x && c.y === bestMove.y);
            if (idx > 0) {
                const top = rootCandidates.splice(idx, 1)[0];
                rootCandidates.unshift(top);
            }

            postMessage({ cmd: 'progress', depth, elapsed: now()-startTimeGlobal, nodes: nodesGlobal, nps: nodesGlobal/Math.max(0.001,(now()-startTimeGlobal)/1000), candidate: `(${bestMove.x},${bestMove.y})`, eval: bestScore, log: `深さ ${depth}: 最善手 (${bestMove.x},${bestMove.y}), 評価 ${bestScore}` });
        }

        if (bestScore >= SCORE.FIVE / 2) break;
        depth++;
    }

    const elapsedTotal = now() - startTimeGlobal;
    return { bestMove, depth: depth-1, nodes: nodesGlobal, elapsed: elapsedTotal, bestScore };
}

export { /* worker entrypoint via onmessage */ };
