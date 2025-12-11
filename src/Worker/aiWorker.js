/**
 * 統合された AI Worker (差分計算最適化版)
 *
 * 修正内容:
 * 1. 【高速化】pushMove/popMove を分離。
 * - pushMove/popMove: 盤面・ハッシュのみ更新（軽量）。候補手生成時に使用。
 * - pushMoveUpdate/popMoveUpdate: スコア差分更新も含む（重量）。探索進行時に使用。
 * これにより、generateMovesLocal 内での無駄なスコア計算を排除。
 * 2. 既存のロジック（中抜け棒四判定、ムーブオーダリング、端判定など）は全て維持。
 */

// ==========================================
// Part 1: Worker_utils.js
// ==========================================

const BOARD_SIZE_DEFAULT = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

// 方向ベクトル
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

const SCORE = {
    FIVE:       100000000,
    OPEN_FOUR:   10000000, // 必勝
    FOUR:         2000000, // 危険
    OPEN_THREE:    100000, // 強い攻撃
    THREE:          10000,
    OPEN_TWO:        1000,
    TWO:              100,
    ONE:               10
};

const PATTERN_SCORES = {
    JUMP_THREE: SCORE.THREE * 2
};

const BONUS = {
    FORK: Math.floor(SCORE.OPEN_FOUR * 5),
    SINGLE_OPEN_FOUR: Math.floor(SCORE.OPEN_FOUR * 3),
    DOUBLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 5),
    SINGLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 3),
    NEIGHBOR: 50,
    KILLER: 1000000
};

// --- 時刻取得 ---
function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// --- 基本ユーティリティ ---
function deepCopyBoard(b) {
    const len = b.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = b[i].slice();
    }
    return out;
}

function inBounds(x, y, boardSize = BOARD_SIZE_DEFAULT) {
    return x >= 0 && x < boardSize && y >= 0 && y < boardSize;
}

// --- Zobrist helpers ---
function rand32() {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

function createZobrist(boardSize = BOARD_SIZE_DEFAULT) {
    const zobrist = new Array(boardSize);
    for (let y = 0; y < boardSize; y++) {
        const row = new Array(boardSize);
        for (let x = 0; x < boardSize; x++) {
            row[x] = [0, rand32(), rand32()];
        }
        zobrist[y] = row;
    }
    return zobrist;
}

function computeHashFromBoard(board, zobrist) {
    let h = 0 >>> 0;
    const bs = board.length;
    for (let y = 0; y < bs; y++) {
        const row = board[y];
        const zrow = zobrist[y];
        for (let x = 0; x < bs; x++) {
            const v = row[x];
            if (v !== EMPTY) {
                h = (h ^ zrow[x][v]) >>> 0;
            }
        }
    }
    return h >>> 0;
}

// --- 勝利判定 ---
function checkWin(board, x, y, player, boardSize = BOARD_SIZE_DEFAULT) {
    for (let d = 0; d < 4; d++) {
        const dx = DIRS[d][0], dy = DIRS[d][1];
        let cnt = 1;
        for (let i = 1; i < 5; i++) {
            const nx = x + i * dx;
            const ny = y + i * dy;
            if (nx < 0 || ny < 0 || nx >= boardSize || ny >= boardSize || board[ny][nx] !== player) break;
            cnt++;
        }
        for (let i = 1; i < 5; i++) {
            const nx = x - i * dx;
            const ny = y - i * dy;
            if (nx < 0 || ny < 0 || nx >= boardSize || ny >= boardSize || board[ny][nx] !== player) break;
            cnt++;
        }
        if (cnt >= 5) return true;
    }
    return false;
}

// --- 候補生成 ---
function generateCandidatesFromHistory(board, hist = [], radius = 2, boardSize = BOARD_SIZE_DEFAULT) {
    const set = new Set();
    const bs = board ? board.length : 0;
    if (bs === 0) return [];

    const candidates = [];
    const tryAdd = (cx, cy) => {
        if (cx < 0 || cx >= bs || cy < 0 || cy >= bs) return;
        if (!board[cy]) return;
        if (board[cy][cx] === EMPTY) {
            const key = cx * bs + cy;
            if (!set.has(key)) {
                set.add(key);
                candidates.push({ x: cx, y: cy });
            }
        }
    };

    if (hist && hist.length > 0) {
        for (let i = 0; i < hist.length; i++) {
            const { x: bx, y: by } = hist[i];
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    tryAdd(bx + dx, by + dy);
                }
            }
        }
    } else {
        for (let y = 0; y < bs; y++) {
            for (let x = 0; x < bs; x++) {
                if (board[y][x] !== EMPTY) {
                    for (let dy = -radius; dy <= radius; dy++) {
                        for (let dx = -radius; dx <= radius; dx++) {
                            if (dx === 0 && dy === 0) continue;
                            tryAdd(x + dx, y + dy);
                        }
                    }
                }
            }
        }
    }

    if (candidates.length === 0) {
        const c = Math.floor(bs / 2);
        if (board[c] && board[c][c] === EMPTY) return [{ x: c, y: c }];
        for (let y = 0; y < bs; y++) {
            for (let x = 0; x < bs; x++) {
                if (board[y][x] === EMPTY) candidates.push({ x, y });
            }
        }
    }
    return candidates;
}

// ================================
// 評価関数（ベクターベース・厳密判定）
// ================================

function evaluateLineVector(board, sx, sy, dx, dy, len, player) {
    const opponent = 3 ^ player;
    let score = 0;

    if (len < 5) return 0;

    // --- 連続5 (Five) ---
    for (let i = 0; i <= len - 5; i++) {
        const y0 = sy + i*dy, x0 = sx + i*dx;
        if (board[y0][x0] === player &&
            board[y0 + dy][x0 + dx] === player &&
            board[y0 + 2*dy][x0 + 2*dx] === player &&
            board[y0 + 3*dy][x0 + 3*dx] === player &&
            board[y0 + 4*dy][x0 + 4*dx] === player) {
            return SCORE.FIVE;
        }
    }

    // --- 長さ6窓判定 ---
    for (let i = 0; i <= len - 6; i++) {
        const y0 = sy + i*dy, x0 = sx + i*dx;
        const w0 = board[y0][x0];
        const w5 = board[y0 + 5*dy][x0 + 5*dx];

        if (w0 === EMPTY && w5 === EMPTY) {
            const w1 = board[y0 + dy][x0 + dx];
            const w2 = board[y0 + 2*dy][x0 + 2*dx];
            const w3 = board[y0 + 3*dy][x0 + 3*dx];
            const w4 = board[y0 + 4*dy][x0 + 4*dx];

            let innerP = 0;
            let innerE = 0;
            
            if (w1 === player) innerP++; else if (w1 === EMPTY) innerE++;
            if (w2 === player) innerP++; else if (w2 === EMPTY) innerE++;
            if (w3 === player) innerP++; else if (w3 === EMPTY) innerE++;
            if (w4 === player) innerP++; else if (w4 === EMPTY) innerE++;

            if (innerP === 4) {
                score += SCORE.OPEN_FOUR;
            } else if (innerP === 3 && innerE === 1) {
                // 中抜け棒四
                score += SCORE.OPEN_FOUR;
            } else if (innerP === 2 && innerE === 2) {
                if ((w1 === player && w2 === EMPTY && w3 === player && w4 === player) ||
                    (w1 === player && w2 === player && w3 === EMPTY && w4 === player)) {
                    score += PATTERN_SCORES.JUMP_THREE;
                }
            }
        }
    }

    // --- 長さ5窓判定 ---
    for (let i = 0; i <= len - 5; i++) {
        let pCount = 0;
        let eCount = 0;
        let hasOpp = false;
        
        for(let k=0; k<5; k++) {
            const val = board[sy + (i+k)*dy][sx + (i+k)*dx];
            if (val === player) {
                pCount++;
            } else if (val === EMPTY) {
                eCount++;
            } else {
                hasOpp = true; break;
            }
        }

        if (hasOpp) continue;

        if (pCount === 4 && eCount === 1) {
            score += SCORE.FOUR;
        }
        if (pCount === 3 && eCount === 2) {
            score += SCORE.THREE;
        }
    }

    return score;
}

/**
 * 初期スコア計算
 */
function calculateTotalBoardScore(board) {
    let blackScore = 0;
    let whiteScore = 0;
    const bs = board.length;

    // 1. 横
    for (let y = 0; y < bs; y++) {
        blackScore += evaluateLineVector(board, 0, y, 1, 0, bs, BLACK);
        whiteScore += evaluateLineVector(board, 0, y, 1, 0, bs, WHITE);
    }
    // 2. 縦
    for (let x = 0; x < bs; x++) {
        blackScore += evaluateLineVector(board, x, 0, 0, 1, bs, BLACK);
        whiteScore += evaluateLineVector(board, x, 0, 0, 1, bs, WHITE);
    }
    // 3. 斜め (\)
    for (let y = 0; y < bs; y++) {
        const len = bs - y;
        if (len < 5) continue; 
        blackScore += evaluateLineVector(board, 0, y, 1, 1, len, BLACK);
        whiteScore += evaluateLineVector(board, 0, y, 1, 1, len, WHITE);
    }
    for (let x = 1; x < bs; x++) {
        const len = bs - x;
        if (len < 5) continue;
        blackScore += evaluateLineVector(board, x, 0, 1, 1, len, BLACK);
        whiteScore += evaluateLineVector(board, x, 0, 1, 1, len, WHITE);
    }
    // 4. 斜め (/)
    for (let x = 0; x < bs; x++) {
        const len = x + 1;
        if (len < 5) continue;
        blackScore += evaluateLineVector(board, x, 0, -1, 1, len, BLACK);
        whiteScore += evaluateLineVector(board, x, 0, -1, 1, len, WHITE);
    }
    for (let y = 1; y < bs; y++) {
        const len = bs - y;
        if (len < 5) continue;
        blackScore += evaluateLineVector(board, bs - 1, y, -1, 1, len, BLACK);
        whiteScore += evaluateLineVector(board, bs - 1, y, -1, 1, len, WHITE);
    }

    return { black: blackScore, white: whiteScore };
}

/**
 * 4ラインのスコア合計を計算
 */
function calc4LinesScore(board, x, y, player, bs) {
    let score = 0;
    
    // 1. 横
    score += evaluateLineVector(board, 0, y, 1, 0, bs, player);
    
    // 2. 縦
    score += evaluateLineVector(board, x, 0, 0, 1, bs, player);
    
    // 3. 斜め \
    {
        const d = (x < y) ? x : y;
        const sx = x - d;
        const sy = y - d;
        const len = bs - Math.max(sx, sy);
        if (len >= 5) {
             score += evaluateLineVector(board, sx, sy, 1, 1, len, player);
        }
    }
    
    // 4. 斜め /
    {
        const dist = Math.min(bs - 1 - x, y);
        const sx = x + dist;
        const sy = y - dist;
        const len = Math.min(sx + 1, bs - sy);
        if (len >= 5) {
            score += evaluateLineVector(board, sx, sy, -1, 1, len, player);
        }
    }
    
    return score;
}


// ==========================================
// Part 2: Worker_State.js
// ==========================================

let state = {
    board: null,
    zobrist: null,
    currentHash: 0,
    history: [],
    score: { black: 0, white: 0 }
};

let transpositionTable = new Map();
let evalCache = new Map();

// Move Ordering Data
const MAX_DEPTH = 30;
let killerMoves = []; 
let historyTable = [];

function initState(boardData, historyData) {
    state.board = deepCopyBoard(boardData);
    state.history = historyData ? JSON.parse(JSON.stringify(historyData)) : [];
    if (!state.zobrist) {
        state.zobrist = createZobrist(BOARD_SIZE_DEFAULT);
    }
    transpositionTable.clear();
    evalCache = new Map();
    state.currentHash = computeHashFromBoard(state.board, state.zobrist);
    state.score = calculateTotalBoardScore(state.board);
    
    const bs = state.board.length;
    killerMoves = new Array(MAX_DEPTH).fill(null).map(() => []);
    historyTable = new Array(bs).fill(0).map(() => new Array(bs).fill(0));
}

// 【軽量版】盤面・ハッシュのみ更新 (候補手生成用)
function pushMove(x, y, player) {
    state.board[y][x] = player;
    state.history.push({ x, y, player });
    state.currentHash = (state.currentHash ^ state.zobrist[y][x][player]) >>> 0;
}

function popMove() {
    const last = state.history.pop();
    if (!last) return null;
    state.board[last.y][last.x] = EMPTY;
    state.currentHash = (state.currentHash ^ state.zobrist[last.y][last.x][last.player]) >>> 0;
    return last;
}

// 【重量版】盤面・ハッシュ・スコア差分更新 (探索用)
function pushMoveUpdate(x, y, player) {
    const bs = state.board.length;
    const beforeBlack = calc4LinesScore(state.board, x, y, BLACK, bs);
    const beforeWhite = calc4LinesScore(state.board, x, y, WHITE, bs);

    state.score.black -= beforeBlack;
    state.score.white -= beforeWhite;

    pushMove(x, y, player); // 軽量版呼び出し

    const afterBlack = calc4LinesScore(state.board, x, y, BLACK, bs);
    const afterWhite = calc4LinesScore(state.board, x, y, WHITE, bs);

    state.score.black += afterBlack;
    state.score.white += afterWhite;
}

function popMoveUpdate() {
    const last = state.history[state.history.length - 1];
    if (!last) return null;
    const { x, y } = last;
    const bs = state.board.length;

    const beforeBlack = calc4LinesScore(state.board, x, y, BLACK, bs);
    const beforeWhite = calc4LinesScore(state.board, x, y, WHITE, bs);
    
    state.score.black -= beforeBlack;
    state.score.white -= beforeWhite;

    popMove(); // 軽量版呼び出し

    const afterBlack = calc4LinesScore(state.board, x, y, BLACK, bs);
    const afterWhite = calc4LinesScore(state.board, x, y, WHITE, bs);

    state.score.black += afterBlack;
    state.score.white += afterWhite;
    
    return last;
}

function updateKillerMove(ply, move) {
    if (ply >= MAX_DEPTH) return;
    const kills = killerMoves[ply];
    if (kills.some(k => k.x === move.x && k.y === move.y)) return;
    kills.unshift(move);
    if (kills.length > 2) kills.pop();
}

function updateHistory(move, depth) {
    historyTable[move.y][move.x] += depth * depth;
    if (historyTable[move.y][move.x] > 100000000) {
        for (let y = 0; y < historyTable.length; y++) {
            for (let x = 0; x < historyTable.length; x++) {
                historyTable[y][x] = Math.floor(historyTable[y][x] / 2);
            }
        }
    }
}


// ==========================================
// Part 3: Worker_Engine.js
// ==========================================

let settings = null;
let playerColor = null;
let aiColor = null;
let startTimeGlobal = 0;
let nodesGlobal = 0;

let lastReportTime = 0;
let lastReportNodes = 0;
const REPORT_NODES = 500;
const REPORT_MS = 100;

function maybeReport(depth, currentEval, currentCandidate) {
    const nodesSince = nodesGlobal - lastReportNodes;
    if (nodesSince < REPORT_NODES) return; 

    const t = now();
    if ((t - lastReportTime) >= REPORT_MS) {
        lastReportTime = t;
        lastReportNodes = nodesGlobal;
        const elapsed = t - startTimeGlobal;
        const nps = (nodesGlobal / Math.max(0.001, elapsed / 1000));

        postMessage({
            cmd: 'progress',
            depth, elapsed, nodes: nodesGlobal, nps,
            candidate: currentCandidate, eval: currentEval
        });
    }
}

function executeSearch(config) {
    settings = config.settings;
    playerColor = config.playerColor;
    aiColor = config.aiColor;
    startTimeGlobal = now();
    nodesGlobal = 0;
    lastReportTime = startTimeGlobal;
    lastReportNodes = 0;

    const radius = Math.max(1, settings.radius || 2);
    const timeLimit = Math.max(50, settings.timeLimit || 1200);
    const minDepth = Math.max(1, settings.minDepth || 1);
    const ASPIRATION_DELTA = typeof settings.aspirationDelta === 'number' ? settings.aspirationDelta : 2000;

    // 即勝判定は軽量版 pushMove でOK
    const cpuWins = getImmediateWinningMovesLocal(aiColor, radius);
    if (cpuWins.length > 0) return { bestMove: cpuWins[0], depth: 0, nodes: 1, elapsed: now() - startTimeGlobal, bestScore: SCORE.FIVE };

    const oppWins = getImmediateWinningMovesLocal(playerColor, radius);
    if (oppWins.length > 0) {
        if (oppWins.length === 1) {
            return { bestMove: oppWins[0], depth: 0, nodes: 1, elapsed: now() - startTimeGlobal, bestScore: SCORE.OPEN_FOUR * 2 };
        }
        return { bestMove: oppWins[0], depth: 0, nodes: 1, elapsed: now() - startTimeGlobal, bestScore: -SCORE.FIVE };
    }

    let bestMove = null;
    let bestScore = -Infinity;
    let depth = 1;
    const MAX_SEARCH_DEPTH = 12;

    const rootCandidates = generateMovesLocal(aiColor, radius, 0); 
    if (rootCandidates.length === 0) return { bestMove: null, bestScore: 0, depth: 0, nodes: 0, elapsed: 0 };

    bestMove = { x: rootCandidates[0].x, y: rootCandidates[0].y };

    while (true) {
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

        const searchRoot = (alphaIn, betaIn) => {
            let localBestScore = -Infinity;
            let localBestMove = null;
            
            const maxRootMoves = 50; 
            const movesToSearch = rootCandidates.slice(0, Math.min(rootCandidates.length, maxRootMoves));

            for (const cand of movesToSearch) {
                // 探索本流なので重量版 (Update) を使用
                pushMoveUpdate(cand.x, cand.y, aiColor);
                const res = negamax(depth - 1, -betaIn, -alphaIn, playerColor, radius, 1);
                popMoveUpdate();

                const score = -res.score;
                if (score > localBestScore) {
                    localBestScore = score;
                    localBestMove = cand;
                }

                if (localBestScore > alphaIn) {
                    alphaIn = localBestScore;
                    updateHistory(cand, depth);
                }

                maybeReport(depth, score, `(${cand.x},${cand.y})`);
                if (now() - startTimeGlobal > timeLimit && depth > minDepth) break;
            }
            return { score: localBestScore, move: localBestMove };
        };

        const result = searchRoot(alpha, beta);
        bestScoreThisDepth = result.score;
        bestMoveThisDepth = result.move;

        if (bestScoreThisDepth <= alpha || bestScoreThisDepth >= beta) {
            const fullResult = searchRoot(-Infinity, Infinity);
            bestScoreThisDepth = fullResult.score;
            bestMoveThisDepth = fullResult.move;
        }

        if (bestMoveThisDepth) {
            bestMove = bestMoveThisDepth;
            bestScore = bestScoreThisDepth;
            const idx = rootCandidates.findIndex(c => c.x === bestMove.x && c.y === bestMove.y);
            if (idx > 0) rootCandidates.unshift(rootCandidates.splice(idx, 1)[0]);
            maybeReport(depth, bestScore, `(${bestMove.x},${bestMove.y})`);
        }

        if (bestScore >= SCORE.FIVE / 2) break;
        depth++;
    }

    return { bestMove, depth: depth - 1, nodes: nodesGlobal, elapsed: now() - startTimeGlobal, bestScore };
}

function negamax(depth, alpha, beta, player, radius, ply) {
    nodesGlobal++;

    const ttKey = `${state.currentHash}:${depth}:${player}`;
    const ttEntry = transpositionTable.get(ttKey);
    if (ttEntry && ttEntry.depth >= depth) {
        if (ttEntry.flag === 'EXACT') return { score: ttEntry.score, nodes: 1 };
        if (ttEntry.flag === 'LOWER' && ttEntry.score > alpha) alpha = ttEntry.score;
        if (ttEntry.flag === 'UPPER' && ttEntry.score < beta) beta = ttEntry.score;
        if (alpha >= beta) return { score: ttEntry.score, nodes: 1 };
    }

    if (depth <= 0) {
        const q = quiescence(player, alpha, beta, radius, 6);
        transpositionTable.set(ttKey, { score: q, depth: 0, flag: 'EXACT' });
        return { score: q, nodes: 1 };
    }

    let moves = generateMovesLocal(player, radius, ply);
    if (moves.length === 0) {
        const val = evaluateBoardLocal(player);
        return { score: val, nodes: 1 };
    }

    if (ttEntry && ttEntry.bestMove) {
        const idx = moves.findIndex(m => m.x === ttEntry.bestMove.x && m.y === ttEntry.bestMove.y);
        if (idx > 0) moves.unshift(moves.splice(idx, 1)[0]);
    }

    let bestScore = -Infinity;
    let bestMoveLocal = null;
    const opponent = player === BLACK ? WHITE : BLACK;
    const origAlpha = alpha;

    for (const mv of moves) {
        // 探索本流なので重量版を使用
        pushMoveUpdate(mv.x, mv.y, player);
        const res = negamax(depth - 1, -beta, -alpha, opponent, radius, ply + 1);
        popMoveUpdate();

        const score = -res.score;
        if (score > bestScore) {
            bestScore = score;
            bestMoveLocal = mv;
        }
        
        if (score > alpha) {
            alpha = score;
            updateHistory(mv, depth);
        }
        
        if (alpha >= beta) {
            updateKillerMove(ply, mv);
            break;
        }
    }

    let flag = 'EXACT';
    if (bestScore <= origAlpha) flag = 'UPPER';
    else if (bestScore >= beta) flag = 'LOWER';
    transpositionTable.set(ttKey, { score: bestScore, depth, flag, bestMove: bestMoveLocal });

    return { score: bestScore, nodes: nodesGlobal + 1 };
}

function quiescence(player, alpha, beta, radius, qDepth) {
    if (qDepth <= 0) return evaluateBoardLocal(player);
    if ((now() - startTimeGlobal) > Math.max(50, settings.timeLimit || 1200)) return evaluateBoardLocal(player);

    nodesGlobal++;

    // ここでの判定にはスコア不要なので軽量版を使用
    const myWins = getImmediateWinningMovesLocal(player, radius);
    if (myWins.length > 0) return SCORE.FIVE;

    const stand_pat = evaluateBoardLocal(player);
    if (stand_pat >= beta) return stand_pat;
    if (alpha < stand_pat) alpha = stand_pat;

    const moves = [];
    const opponent = player === BLACK ? WHITE : BLACK;

    const oppWins = getImmediateWinningMovesLocal(opponent, radius);
    for (const m of oppWins) moves.push({ ...m, score: SCORE.OPEN_FOUR * 3 });

    const oppOpenThrees = getOpenThreeMovesLocal(opponent, radius);
    for (const m of oppOpenThrees) moves.push({ ...m, score: SCORE.FOUR });

    const myOpenThrees = getOpenThreeMovesLocal(player, radius);
    for (const m of myOpenThrees) moves.push({ ...m, score: SCORE.OPEN_THREE });

    moves.sort((a, b) => b.score - a.score);

    const seen = new Set();
    const bs = state.board.length;

    for (const mv of moves) {
        const key = mv.x * bs + mv.y;
        if (seen.has(key) || state.board[mv.y][mv.x] !== EMPTY) continue;
        seen.add(key);

        // 静止探索も探索本流なので重量版を使用
        pushMoveUpdate(mv.x, mv.y, player);
        const score = -quiescence(opponent, -beta, -alpha, radius, qDepth - 1);
        popMoveUpdate();

        if (score >= beta) return score;
        if (score > alpha) alpha = score;
    }
    return alpha;
}


// =========================================================
// Helper Wrappers
// =========================================================

function generateCandidatesFromHistoryWrapper(radius) {
    return generateCandidatesFromHistory(state.board, state.history, radius, state.board.length);
}

function evaluateBoardLocal(player) {
    let playerScore, opponentScore;
    if (player === BLACK) {
        playerScore = state.score.black;
        opponentScore = state.score.white;
    } else {
        playerScore = state.score.white;
        opponentScore = state.score.black;
    }

    if (playerScore >= SCORE.OPEN_FOUR) {
        return playerScore;
    }
    return playerScore - (opponentScore * 1.2);
}

// 候補手生成用：軽量版 pushMove を使用
function getMoveScoreLocal(x, y, player) {
    const cacheKey = `${state.currentHash}:movescore:${player}:${x},${y}:h${state.history.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey);

    let totalScore = 0;
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    let open3Count = 0;
    let fourCount = 0;
    
    const bs = state.board.length;

    pushMove(x, y, player); // 軽量版
    try {
        for (let d = 0; d < 4; d++) {
            const dx = directions[d][0], dy = directions[d][1];
            let startK = 0;
            for(let k=4; k>=0; k--) {
                const tx = x - k*dx, ty = y - k*dy;
                if(tx >= 0 && tx < bs && ty >= 0 && ty < bs) {
                    startK = -k; 
                    break;
                }
            }
            let endK = 0;
            for(let k=4; k>=0; k--) {
                 const tx = x + k*dx, ty = y + k*dy;
                 if(tx >= 0 && tx < bs && ty >= 0 && ty < bs) {
                    endK = k; 
                    break;
                }
            }
            const realSx = x + startK * dx;
            const realSy = y + startK * dy;
            const realLen = endK - startK + 1;
            
            let dirScore = 0;
            if(realLen >= 5) {
                dirScore = evaluateLineVector(state.board, realSx, realSy, dx, dy, realLen, player);
            }
            
            totalScore += dirScore;
            
            if (dirScore >= SCORE.OPEN_FOUR) {
                fourCount++;
            } else if (dirScore >= SCORE.FOUR) {
                fourCount++;
            } else if (dirScore >= SCORE.OPEN_THREE) {
                open3Count++;
            }
        }
        
        if (fourCount >= 1 && open3Count >= 1) {
            totalScore += BONUS.FORK;
        } else if (open3Count >= 2) {
            totalScore += BONUS.DOUBLE_OPEN_THREE;
        }
        
    } finally {
        popMove(); // 軽量版
    }
    evalCache.set(cacheKey, totalScore);
    return totalScore;
}

function getImmediateWinningMovesLocal(player, radius) {
    const cacheKey = `${state.currentHash}:imwin:${player}:r${radius}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();

    const wins = [];
    const candidates = generateCandidatesFromHistoryWrapper(radius);
    const boardLocal = state.board;
    const bs = boardLocal.length;

    for (const c of candidates) {
        if (boardLocal[c.y][c.x] !== EMPTY) continue;
        pushMove(c.x, c.y, player); // 軽量版
        if (checkWin(boardLocal, c.x, c.y, player, bs)) {
            wins.push({ x: c.x, y: c.y });
        }
        popMove(); // 軽量版
    }
    evalCache.set(cacheKey, wins.slice());
    return wins;
}

function getOpenThreeMovesLocal(player, radius) {
    const cacheKey = `${state.currentHash}:openthree:${player}:r${radius}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();

    const moves = [];
    const candidates = generateCandidatesFromHistoryWrapper(radius);
    
    for (const c of candidates) {
        if (state.board[c.y][c.x] !== EMPTY) continue;
        const score = getMoveScoreLocal(c.x, c.y, player);
        if (score >= SCORE.OPEN_THREE) {
            moves.push(c);
        }
    }
    evalCache.set(cacheKey, moves.slice());
    return moves;
}

function generateMovesLocal(player, radius, ply) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const candidates = generateCandidatesFromHistoryWrapper(radius);
    const scoredMoves = [];

    const myWins = getImmediateWinningMovesLocal(player, radius);
    if (myWins.length > 0) return myWins.map(m => ({ x: m.x, y: m.y, score: SCORE.FIVE }));

    const oppWins = getImmediateWinningMovesLocal(opponent, radius);
    if (oppWins.length > 0) {
        if (oppWins.length === 1) {
            return [{ x: oppWins[0].x, y: oppWins[0].y, score: SCORE.OPEN_FOUR * 2 }];
        }
        for (const w of oppWins) candidates.unshift(w);
    }

    const seen = new Set();
    const bs = state.board.length;
    
    const lastMove = state.history.length > 0 ? state.history[state.history.length - 1] : null;
    const killers = (ply < MAX_DEPTH) ? killerMoves[ply] : [];

    for (const c of candidates) {
        const key = c.x * bs + c.y;
        if (seen.has(key)) continue;
        seen.add(key);
        if (state.board[c.y][c.x] !== EMPTY) continue;

        // ここがボトルネックだった場所
        // 軽量版 pushMove を使う getMoveScoreLocal になったため高速化
        const attackScore = getMoveScoreLocal(c.x, c.y, player);
        const defenseScore = getMoveScoreLocal(c.x, c.y, opponent);

        let totalScore = attackScore + defenseScore;

        if (defenseScore >= SCORE.FOUR) totalScore += SCORE.OPEN_FOUR;
        else if (defenseScore >= SCORE.OPEN_THREE) totalScore += SCORE.FOUR;
        else if (attackScore >= SCORE.OPEN_THREE) totalScore += SCORE.OPEN_THREE;

        if (lastMove) {
            const dist = Math.max(Math.abs(c.x - lastMove.x), Math.abs(c.y - lastMove.y));
            if (dist <= 2) totalScore += BONUS.NEIGHBOR;
        }
        
        totalScore += historyTable[c.y][c.x];
        
        if (killers.some(k => k.x === c.x && k.y === c.y)) {
            totalScore += BONUS.KILLER;
        }

        scoredMoves.push({ x: c.x, y: c.y, score: totalScore });
    }

    scoredMoves.sort((a, b) => b.score - a.score);
    return scoredMoves.slice(0, 50);
}

function generateRootCandidates(player, radius) {
    return generateMovesLocal(player, radius, 0);
}

onmessage = (e) => {
    const data = e.data;
    if (!data || data.cmd !== 'think') return;

    try {
        initState(data.board, data.history);
        const result = executeSearch({
            settings: data.settings || {},
            playerColor: data.playerColor,
            aiColor: data.aiColor
        });

        postMessage({
            cmd: 'result',
            bestMove: result.bestMove,
            depth: result.depth,
            nodes: result.nodes,
            elapsed: result.elapsed,
            eval: result.bestScore
        });

    } catch (err) {
        postMessage({ cmd: 'error', message: String(err) });
        console.error(err);
    }
};
