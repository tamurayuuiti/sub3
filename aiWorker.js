// aiWorker.js (ES module)
// gomoku_utils.js と同ディレクトリに配置し、ワーカーは type:'module' で起動してください。
import * as G from './gomoku_utils.js';

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

    // board は二次元配列 [row][col] の形（y,x）
    state.board = G.deepCopyBoard(data.board);
    settings = data.settings || {};
    // デフォルト設定
    settings.radius = settings.radius || 2;
    settings.timeLimit = (typeof settings.timeLimit === 'number') ? settings.timeLimit : 1200;
    settings.minDepth = Math.max(1, settings.minDepth || 1);
    settings.maxQuiescenceDepth = settings.maxQuiescenceDepth || 8;
    // mode: 'pvpProb' (デフォルト) または 'aiMove'（従来動作）
    settings.mode = settings.mode || 'pvpProb';
    // 勝率変換のスケール（大きいほど評価値が小さくても中立に近い）
    settings.probScale = (typeof settings.probScale === 'number') ? settings.probScale : 2000000;
    // 両者個別評価を計算するか（true の場合時間は2倍近くなる）
    settings.computeBoth = !!settings.computeBoth;

    // playerColor / aiColor は旧仕様互換（必要なら）
    playerColor = data.playerColor;
    aiColor = data.aiColor;
    state.history = data.history ? JSON.parse(JSON.stringify(data.history)) : [];

    nodesGlobal = 0;
    lastReportTime = now();
    lastReportNodes = 0;

    try {
        if (settings.mode === 'aiMove') {
            // 互換モード：従来の AI 最善手探索を呼ぶ（runAI を移植）
            const result = runAI(); // 既存の挙動を保持
            postMessage({ cmd: 'result', mode: 'aiMove', bestMove: result.bestMove, depth: result.depth, nodes: result.nodes, elapsed: result.elapsed, eval: result.bestScore });
        } else {
            // デフォルト：PvP 勝率算出モード
            const result = runPvPWinProb();
            postMessage(Object.assign({ cmd: 'result', mode: 'pvpProb' }, result));
        }
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

function makeMoveHash(x,y,player, hist) {
    G.pushMove(state, x, y, player);
}
function undoMoveHash(hist) {
    return G.popMove(state);
}

// ----------------- 候補生成 / 評価ラッパー -----------------
function generateCandidatesFromHistory(hist, radius) {
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

function getImmediateWinningMovesLocal(player, b, hist, radius) {
    const cacheKey = `${state.currentHash}:imwin:${player}:r${radius}:h${(hist||state.history).length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();
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
                else line.push(3);
            }
            score += evaluateLineLocal(line, player);
        }
    } finally {
        undoMoveHash(state.history);
    }

    evalCache.set(cacheKey, score);
    return score;
}

// ----------------- generateMoves / generateRootCandidates -----------------
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

// ----------------- レポート -----------------
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

// ----------------- Quiescence -----------------
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

// ----------------- negamax (PVS 実装) -----------------
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

    // TT の最善手を先頭に（move ordering）
    const ttBest = ttEntry && ttEntry.bestMove ? ttEntry.bestMove : null;
    if (ttBest) {
        const idx = moves.findIndex(m => m.x === ttBest.x && m.y === ttBest.y);
        if (idx > 0) {
            const m = moves.splice(idx,1)[0];
            moves.unshift(m);
        }
    }

    // 探索制限（枝刈りのため）
    let maxMoves;
    if (depth >= 6) maxMoves = 10;
    else if (depth >= 4) maxMoves = 18;
    else maxMoves = 30;
    if (moves.length > maxMoves) moves.length = maxMoves;

    const origAlpha = alpha;
    let bestMoveLocal = null;

    // PVS: first move -> full window; others -> null-window then re-search if necessary
    let isFirst = true;
    const opponent = (player === BLACK) ? WHITE : BLACK;

    for (const mv of moves) {
        makeMoveHash(mv.x, mv.y, player, hist);

        let childRes;
        if (isFirst) {
            // 最初の手はフルウィンドウで探索
            childRes = negamax(depth - 1, -beta, -alpha, opponent, b, hist, radius);
            nodes += childRes.nodes;
            var score = -childRes.score;
        } else {
            // null-window
            childRes = negamax(depth - 1, -alpha - 1, -alpha, opponent, b, hist, radius);
            nodes += childRes.nodes;
            var score = -childRes.score;
            // null-window が期待以上なら（すなわち真に良い手なら）フルウィンドウで再探索
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
            // βカット（枝切り）
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

// ----------------- runAI (従来機能を保持) -----------------
// （元の runAI をほぼそのまま残す。settings.mode === 'aiMove' のときに呼ばれる）
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

    // Aspiration delta: settings で上書き可能
    const ASPIRATION_DELTA = typeof settings.aspirationDelta === 'number' ? settings.aspirationDelta : 2000;

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

        // Aspiration Window の初期化
        let alpha = -Infinity, beta = Infinity;
        if (depth > 1 && Number.isFinite(bestScore) && Math.abs(bestScore) < Infinity) {
            alpha = bestScore - ASPIRATION_DELTA;
            beta = bestScore + ASPIRATION_DELTA;
        }

        let bestScoreThisDepth = -Infinity;
        let bestMoveThisDepth = null;

        // ---- 探索パス（通常ウィンドウ or Asp） ----
        const searchOnce = (alphaIn, betaIn) => {
            let localBestScore = -Infinity;
            let localBestMove = null;
            // limit root branching to reasonable number to bound search
            const maxRootMoves = 40;
            const moves = rootCandidates.slice(0, Math.min(rootCandidates.length, maxRootMoves));
            for (const cand of moves) {
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

                // 時間チェック
                if (now() - startTimeGlobal > timeLimit && depth > minDepth) break;
            }
            return { localBestScore, localBestMove };
        };

        // 初回探索（Aspiration window が設定されていればそのウィンドウ、なければフル）
        const initial = searchOnce(alpha, beta);
        bestScoreThisDepth = initial.localBestScore;
        bestMoveThisDepth = initial.localBestMove;

        // fail-low または fail-high の場合はフルウィンドウで再検索する（1回だけ）
        if (bestScoreThisDepth <= alpha || bestScoreThisDepth >= beta) {
            // フルウィンドウで再検索
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

// ----------------- PvP 勝率算出用ユーティリティ -----------------

// 盤上の石数から「次手番」を推定する（先手 = BLACK）
function estimateSideToMoveFromBoard(board) {
    let blackCount = 0, whiteCount = 0;
    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            if (board[y][x] === BLACK) blackCount++;
            else if (board[y][x] === WHITE) whiteCount++;
        }
    }
    // 通常、黒先手。石数が同じなら黒番、黒が一つ多ければ白番。
    if (blackCount === whiteCount) return BLACK;
    if (blackCount > whiteCount) return WHITE;
    // それ以外（異常）は黒に戻す
    return BLACK;
}

// スコア -> 勝率への変換（シグモイド）
function scoreToWinProb(evalScore, scale) {
    // guard
    const s = Math.max(1, Math.abs(scale) || 1);
    // sigmoid
    const v = 1 / (1 + Math.exp(-evalScore / s));
    return v;
}

// PvP 勝率を計算して返す。
// 戻り値: { probBlack, probWhite, evalBlack, depth, nodes, elapsed, note }
function runPvPWinProb() {
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
    const MAX_SEARCH_DEPTH = settings.maxDepth || 10;

    const scale = Math.max(1, settings.probScale || 2000000);

    // どちらの手番かを推定
    const sideToMove = estimateSideToMoveFromBoard(state.board);

    // 短絡処理: 今の局面で即勝が明白な場合は確率 1/0 を返す
    const blackImmediate = getImmediateWinningMovesLocal(BLACK, state.board, state.history, radius);
    const whiteImmediate = getImmediateWinningMovesLocal(WHITE, state.board, state.history, radius);

    if (blackImmediate.length > 0 && whiteImmediate.length === 0) {
        return { probBlack: 1.0, probWhite: 0.0, evalBlack: SCORE.FIVE, depth: 0, nodes: 0, elapsed: now()-startTimeGlobal, note: 'Black immediate win' };
    }
    if (whiteImmediate.length > 0 && blackImmediate.length === 0) {
        return { probBlack: 0.0, probWhite: 1.0, evalBlack: -SCORE.FIVE, depth: 0, nodes: 0, elapsed: now()-startTimeGlobal, note: 'White immediate win' };
    }
    // 両者即勝（理論上同一局面で両方ありうるかは別として）は互いに非常に高い確率として扱う
    if (blackImmediate.length > 0 && whiteImmediate.length > 0) {
        return { probBlack: 0.5, probWhite: 0.5, evalBlack: 0, depth: 0, nodes: 0, elapsed: now()-startTimeGlobal, note: 'Both immediate wins (ambiguous)' };
    }

    // 反復深化で root の評価（手番を root に合わせて呼ぶ）
    let depth = minDepth;
    let lastEvalBlack = 0;
    let lastNodes = 0;
    while (true) {
        currentDepthGlobal = depth;
        const elapsed = now() - startTimeGlobal;
        if (elapsed > timeLimit && depth > minDepth) break;
        if (depth > MAX_SEARCH_DEPTH) break;

        // クリアしないでTTを使いまわせる（性能優先）
        // ただし大きな深さ差では古いTTが誤差を作ることもあるが、ここでは許容する。

        // root 評価は「実際の次手番」を root player として negamax を呼ぶ。
        const rootPlayer = sideToMove;
        // ラッパーとして呼ぶ
        const res = negamax(depth, -Infinity, Infinity, rootPlayer, state.board, state.history, radius);
        lastNodes = res.nodes;
        // res.score は "rootPlayer" 視点の評価値。Black 視点に変換する：
        const evalBlack = (rootPlayer === BLACK) ? res.score : -res.score;
        lastEvalBlack = evalBlack;

        // レポート
        postMessage({ cmd: 'progress', depth, elapsed: now()-startTimeGlobal, nodes: nodesGlobal, nps: nodesGlobal/Math.max(0.001,(now()-startTimeGlobal)/1000), candidate: '-', eval: evalBlack, log: `深さ ${depth}: evalBlack ${evalBlack}` });

        if (now() - startTimeGlobal > timeLimit && depth > minDepth) break;
        depth++;
    }

    const elapsedTotal = now() - startTimeGlobal;

    // 勝率計算：Black 視点の評価を sigmoid に通して Black の勝率とする（White = 1 - Black）
    const rawProbBlack = scoreToWinProb(lastEvalBlack, scale);
    // 正規化して 0..1
    const probBlack = Math.max(0, Math.min(1, rawProbBlack));
    const probWhite = 1 - probBlack;

    return {
        probBlack,
        probWhite,
        evalBlack: lastEvalBlack,
        depth: Math.max(minDepth, depth - 1),
        nodes: nodesGlobal,
        elapsed: elapsedTotal,
        note: 'Approximate via negamax eval -> sigmoid mapping. Use settings.computeBoth=true to compute both sides explicitly.'
    };
}

export { /* none exported - worker entrypoint via onmessage */ };
