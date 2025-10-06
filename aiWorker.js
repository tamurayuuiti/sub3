// aiWorker.js (ES module)
// gomoku_utils.js と同ディレクトリに配置し、ワーカーは type:'module' で起動してください。
import * as G from './gomoku_utils.js';

const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

// スコア等はローカル定義を維持（必要なら G.SCORE を使う設計も可能）
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

// 状態をまとめたオブジェクト
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

function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

onmessage = (e) => {
    const data = e.data;
    if (!data || data.cmd !== 'think') return;

    // board と state の初期化
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

function rand32() { return Math.floor(Math.random() * 0x100000000) >>> 0; }

function computeHashFromBoardLocal() {
    state.currentHash = G.computeHashFromBoard(state.board, state.zobrist);
    return state.currentHash;
}

// 互換ラッパー: 既存コードと同じ名前で呼べるようにする
function makeMoveHash(x,y,player, hist) {
    // hist 引数は互換のため受け取るが、state.history を使う
    G.pushMove(state, x, y, player);
}
function undoMoveHash(hist) {
    // hist 引数は互換のため受け取るが、state.history を使う
    return G.popMove(state);
}


// ----------------- 候補生成: utils を使用 -----------------
function generateCandidatesFromHistory(hist, radius) {
    // hist は caller の配列（通常 state.history）
    return G.generateCandidatesFromHistory(state.board, hist || state.history, radius, BOARD_SIZE);
}


// ----------------- 評価 / パターン検出: utils を利用する薄いラッパー -----------------
function evaluateLineLocal(lineArr, player) {
    // lineArr は数値配列 (0/1/2/3) を想定
    return G.evaluateLineArr(lineArr, player);
}

function evaluateBoardLocal(player, b) {
    // b は board 配列（2D）
    return G.evaluateBoard(b, player);
}

// 勝利判定ラッパー
function checkWinLocal(x,y,player,b) {
    return G.checkWin(b, x, y, player, BOARD_SIZE);
}

// getImmediateWinningMovesLocal / getOpenThreeMovesLocal は utils の state ベース関数を呼ぶが
// evalCache を保持するためローカルラッパーを作る
function getImmediateWinningMovesLocal(player, b, hist, radius) {
    const cacheKey = `${state.currentHash}:imwin:${player}:r${radius}:h${(hist||state.history).length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();

    // 注意: G.getImmediateWinningMoves は state ベース
    const wins = G.getImmediateWinningMoves(state, player, hist || state.history, radius);
    evalCache.set(cacheKey, wins.slice());
    return wins;
}

function getOpenThreeMovesLocal(player, b, hist, radius) {
    const cacheKey = `${state.currentHash}:openthree:${player}:r${radius}:h${(hist||state.history).length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();

    const moves = G.getOpenThreeMoves(state, player, hist || state.history, radius);
    evalCache.set(cacheKey, moves.slice());
    return moves;
}


// getMoveScoreLocal: state を一時変更して各方向のラインを評価（元の振る舞いを維持）
function getMoveScoreLocal(x, y, player, b) {
    const cacheKey = `${state.currentHash}:movescore:${player}:${x},${y}:h${state.history.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey);

    let score = 0;

    makeMoveHash(x, y, player, state.history);
    try {
        const directions = [[1,0],[0,1],[1,1],[1,-1]];
        for (const [dx,dy] of directions) {
            const line = [];
            for (let i = -4; i <= 4; i++) {
                const nx = x + i*dx, ny = y + i*dy;
                if (G.inBounds(nx, ny, BOARD_SIZE)) line.push(state.board[ny][nx]);
                else line.push(3); // out
            }
            score += evaluateLineLocal(line, player);
        }
    } finally {
        undoMoveHash(state.history);
    }

    evalCache.set(cacheKey, score);
    return score;
}


// ----------------- 候補生成 / ルート候補 -----------------
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
        for (const move of oppWins) candidates.unshift({ x: move.x, y: move.y });
    }

    const seen = new Set();
    for (const c of candidates) {
        const key = (c.x << 4) | c.y;
        if (seen.has(key)) continue;
        seen.add(key);

        if (b[c.y][c.x] !== EMPTY) continue;

        const attackScore = getMoveScoreLocal(c.x, c.y, player, b);
        const defenseScore = getMoveScoreLocal(c.x, c.y, opponent, b);

        let totalScore = attackScore + defenseScore;
        if (attackScore >= SCORE.OPEN_THREE) totalScore += attackScore;
        if (defenseScore >= SCORE.OPEN_THREE) totalScore += defenseScore;

        scoredMoves.push({ x: c.x, y: c.y, score: totalScore });
    }

    scoredMoves.sort((a, b) => b.score - a.score);
    return scoredMoves.slice(0, limit);
}

function generateRootCandidates(player, b, hist, radius) {
    const raw = generateMovesLocal(player, b, hist, radius, 80);
    const scored = [];
    for (const mv of raw) {
        const s = getMoveScoreLocal(mv.x, mv.y, player, b);
        scored.push({ x: mv.x, y: mv.y, score: s });
    }
    scored.sort((a,b) => b.score - a.score);
    return scored.map(s => ({x: s.x, y: s.y, score: s.score}));
}


// ----------------- レポート / その他 -----------------
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


// ----------------- Quiescence / Negamax / runAI （元コードとほぼ同内容、state利用） -----------------
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
    for (const mv of oppWins) moves.push({x:mv.x,y:mv.y,score: Math.floor(SCORE.OPEN_FOUR * 3)});

    const myOpenThrees = getOpenThreeMovesLocal(player, b, hist, radius);
    for (const mv of myOpenThrees) moves.push({x:mv.x,y:mv.y,score: BONUS.SINGLE_OPEN_THREE});

    const oppOpenThrees = getOpenThreeMovesLocal(opponent, b, hist, radius);
    for (const mv of oppOpenThrees) moves.push({x:mv.x,y:mv.y,score: Math.floor(SCORE.OPEN_THREE * 2)});

    const seen = new Set();
    moves.sort((a,b)=> b.score - a.score);

    for (const mv of moves) {
        const key = (mv.x<<4) | mv.y;
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

    const ttBest = ttEntry && ttEntry.bestMove ? ttEntry.bestMove : null;
    if (ttBest) {
        const idx = moves.findIndex(m => m.x === ttBest.x && m.y === ttBest.y);
        if (idx > 0) {
            const m = moves.splice(idx,1)[0];
            moves.unshift(m);
        }
    }

    let maxMoves;
    if (depth >= 6) maxMoves = 10;
    else if (depth >= 4) maxMoves = 18;
    else maxMoves = 30;
    if (moves.length > maxMoves) moves.length = maxMoves;

    const origAlpha = alpha;
    let bestMoveLocal = null;

    for (const mv of moves) {
        makeMoveHash(mv.x, mv.y, player, hist);
        const res = negamax(depth - 1, -beta, -alpha, (player===BLACK?WHITE:BLACK), b, hist, radius);
        nodes += res.nodes;
        undoMoveHash(hist);
        const score = -res.score;
        if (score > bestScore) {
            bestScore = score;
            bestMoveLocal = {x: mv.x, y: mv.y};
        }
        alpha = Math.max(alpha, bestScore);
        if (alpha >= beta) break;
    }

    let flag = 'EXACT';
    if (bestScore <= origAlpha) flag = 'UPPER';
    else if (bestScore >= beta) flag = 'LOWER';
    transpositionTable.set(ttKey, { score: bestScore, depth, flag, bestMove: bestMoveLocal });

    return { score: bestScore, nodes: nodes + 1 };
}


// ----------------- runAI -----------------
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

    // --- 短絡処理（脅威解析） ---
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

    // --- 反復深化 ---
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
        let bestScoreThisDepth = -Infinity;
        let bestMoveThisDepth = null;

        for (const cand of rootCandidates) {
            currentCandidateGlobal = `(${cand.x},${cand.y})`;
            makeMoveHash(cand.x, cand.y, aiColor, state.history);

            const res = negamax(depth - 1, -beta, -alpha, playerColor, state.board, state.history, radius);

            undoMoveHash(state.history);

            const score = -res.score;

            if (score > bestScoreThisDepth) {
                bestScoreThisDepth = score;
                bestMoveThisDepth = { x: cand.x, y: cand.y };
                alpha = Math.max(alpha, bestScoreThisDepth);
                currentEvalGlobal = bestScoreThisDepth;
            }
            maybeReport({ log: `深さ${depth} 候補 ${currentCandidateGlobal} 評価 ${score}` });

            if (now() - startTimeGlobal > timeLimit && depth > minDepth) break;
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

export { /* none exported - worker entrypoint via onmessage */ };
