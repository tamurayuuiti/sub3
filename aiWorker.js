// --- 修正版 aiWorker.js ---
// (評価関数/パターン検出/候補生成ロジックを改善)


const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;


// スコア定義（基本値を維持しつつ、バランスを調整）
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


// 飛び三などの評価を追加
const PATTERN_SCORES = {
    JUMP_THREE: SCORE.THREE * 2, // 010110や011010の形。OPEN_THREEよりは弱いがTHREEよりは強い
};



const BONUS = {
    FORK: Math.floor(SCORE.OPEN_FOUR * 5),
    SINGLE_OPEN_FOUR: Math.floor(SCORE.OPEN_FOUR * 3),
    DOUBLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 12),
    SINGLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 3)
};


let board = null;
let settings = null;
let playerColor = null;
let aiColor = null;
let history = [];


let nodesGlobal = 0;
let lastReportTime = 0;
let lastReportNodes = 0;


const REPORT_NODES = 500;
const REPORT_MS = 100;


function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }


onmessage = (e) => {
    const data = e.data;
    if (!data || data.cmd !== 'think') return;
    board = deepCopyBoard(data.board);
    settings = data.settings || { radius: 2, timeLimit: 1200, minDepth: 3, maxQuiescenceDepth: 8 };
    playerColor = data.playerColor;
    aiColor = data.aiColor;
    history = data.history ? JSON.parse(JSON.stringify(data.history)) : [];


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


function deepCopyBoard(b) { return b.map(row => row.slice()); }
function inBounds(x,y){ return x>=0 && x<BOARD_SIZE && y>=0 && y<BOARD_SIZE; }


// --- Zobrist / TT (変更なし) ---
let zobrist = null;
let currentHash = 0;
let transpositionTable = null;
let evalCache = null;


function initZobrist() {
    zobrist = new Array(BOARD_SIZE);
    for (let y=0;y<BOARD_SIZE;y++) {
        zobrist[y] = new Array(BOARD_SIZE);
        for (let x=0;x<BOARD_SIZE;x++) {
            zobrist[y][x] = [0, rand32(), rand32()];
        }
    }
    transpositionTable = new Map();
}


function rand32() { return Math.floor(Math.random() * 0x100000000) >>> 0; }


function computeHashFromBoard(b) {
    let h = 0;
    for (let y=0;y<BOARD_SIZE;y++){
        for (let x=0;x<BOARD_SIZE;x++){
            const v = b[y][x];
            if (v === BLACK || v === WHITE) h ^= zobrist[y][x][v];
        }
    }
    return h >>> 0;
}


function makeMoveHash(x,y,player, hist) {
    board[y][x] = player;
    hist.push({x,y,player});
    currentHash ^= zobrist[y][x][player];
    currentHash >>>= 0;
}


function undoMoveHash(hist) {
    const last = hist.pop();
    board[last.y][last.x] = EMPTY;
    currentHash ^= zobrist[last.y][last.x][last.player];
    currentHash >>>= 0;
    return last;
}


// --- 候補生成 (変更なし) ---
function generateCandidatesFromHistory(hist, radius) {
    const set = new Set();
    if (hist && hist.length > 0) {
        for (const mv of hist) {
            const baseX = mv.x, baseY = mv.y;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const nx = baseX + dx, ny = baseY + dy;
                    if (inBounds(nx,ny) && board[ny][nx] === EMPTY) set.add((nx << 4) | ny);
                }
            }
        }
    } else {
        for (let y=0;y<BOARD_SIZE;y++) {
            for (let x=0;x<BOARD_SIZE;x++) {
                if (board[y][x] === EMPTY) continue;
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = x + dx, ny = y + dy;
                        if (inBounds(nx,ny) && board[ny][nx] === EMPTY) set.add((nx << 4) | ny);
                    }
                }
            }
        }
    }


    if (set.size === 0) {
        let anyStone = false;
        for (let y=0;y<BOARD_SIZE && !anyStone;y++) for (let x=0;x<BOARD_SIZE;x++) if (board[y][x] !== EMPTY) { anyStone = true; break; }
        if (!anyStone) {
            const c = Math.floor(BOARD_SIZE/2);
            return [{x: c, y: c}];
        }
    }


    const arr = [];
    for (const key of set) arr.push({x: key >> 4, y: key & 0xF});


    if (arr.length === 0) {
        for (let y=0;y<BOARD_SIZE;y++) for (let x=0;x<BOARD_SIZE;x++) if (board[y][x]===EMPTY) arr.push({x,y});
    }


    return arr;
}


// --- パターン検出 / 評価関数 ---
function checkWinLocal(x,y,player, b) {
    const dirs = [[1,0],[0,1],[1,1],[1,-1]];
    for (const [dx,dy] of dirs) {
        let cnt = 1;
        for (let i=1;i<5;i++){
            const nx = x + i*dx, ny = y + i*dy;
            if (inBounds(nx,ny) && b[ny][nx] === player) cnt++; else break;
        }
        for (let i=1;i<5;i++){
            const nx = x - i*dx, ny = y - i*dy;
            if (inBounds(nx,ny) && b[ny][nx] === player) cnt++; else break;
        }
        if (cnt >= 5) return true;
    }
    return false;
}


// --- 置換: getImmediateWinningMovesLocal ---
function getImmediateWinningMovesLocal(player, b, hist, radius) {
    // キャッシュキーに radius と hist.length を含める
    const cacheKey = `${currentHash}:imwin:${player}:r${radius}:h${hist.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();


    const wins = [];
    const candidates = generateCandidatesFromHistory(hist, radius);
    for (const c of candidates) {
        const x = c.x, y = c.y;
        if (b[y][x] !== EMPTY) continue;


        // 盤/ハッシュの整合性を保つため makeMoveHash/undoMoveHash を使う
        makeMoveHash(x, y, player, hist);
        try {
            const win = checkWinLocal(x, y, player, b);
            if (win) wins.push({ x, y });
        } finally {
            undoMoveHash(hist);
        }
    }


    evalCache.set(cacheKey, wins.slice());
    return wins;
}


/**
 * @description 【修正点 2】「活き三」の検出ロジックを厳密化
 * 指定したマス(x,y)に石を置くことで、新たに「活き三」が形成されるかチェックする。
 * 活き三のパターン: 01110 (中央), 010110 (中央), 011010 (中央)
 */
// --- 置換: getOpenThreeMovesLocal ---
function getOpenThreeMovesLocal(player, b, hist, radius) {
    const cacheKey = `${currentHash}:openthree:${player}:r${radius}:h${hist.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey).slice();


    const moves = [];
    const p = player.toString();
    const patterns = [
        `0${p.repeat(3)}0`,
        `0${p}0${p}${p}0`,
        `0${p}${p}0${p}0`
    ];


    const candidates = generateCandidatesFromHistory(hist, radius);
    for (const c of candidates) {
        const x = c.x, y = c.y;
        if (b[y][x] !== EMPTY) continue;


        // makeMoveHash/undoMoveHash で一時着手
        makeMoveHash(x, y, player, hist);
        let hasOpenThree = false;
        try {
            const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
            for (const [dx, dy] of directions) {
                let line = '';
                // (x,y)が中心になるように -5..+5 を切り出す
                for (let i = -5; i <= 5; i++) {
                    const nx = x + i * dx, ny = y + i * dy;
                    if (inBounds(nx, ny)) line += b[ny][nx];
                    else line += '3';
                }
                // includes を使って安全に判定（substring の index ミスを回避）
                if (patterns.some(pat => line.includes(pat))) { hasOpenThree = true; break; }
            }
        } finally {
            undoMoveHash(hist);
        }


        if (hasOpenThree) moves.push({ x, y });
    }


    evalCache.set(cacheKey, moves.slice());
    return moves;
}


/**
 * @description 【修正点 1】ライン評価関数を改善
 * - isForMoveGenフラグを廃止し、常に全てのパターンを評価するように変更。
 * - これにより候補手評価の精度が向上し、AIが重要な手を見逃しにくくなる。
 * - 評価が不正確だったパターンを削除し、飛び三などのスコアを追加・調整。
 */
function evaluateLineLocal(line, player) {
    const opponentChar = player === BLACK ? '2' : '1';
    const p = player.toString();
    let score = 0;


    if (line.includes(p.repeat(5))) return SCORE.FIVE;
    if (line.includes(`0${p.repeat(4)}0`)) score += SCORE.OPEN_FOUR;
    if (line.includes(`${opponentChar}${p.repeat(4)}0`) || line.includes(`0${p.repeat(4)}${opponentChar}`)) score += SCORE.FOUR;
    
    // 評価パターンを拡充
    if (line.includes(`0${p.repeat(3)}0`)) score += SCORE.OPEN_THREE;
    if (line.includes(`0${p}0${p}${p}0`) || line.includes(`0${p}${p}0${p}0`)) score += PATTERN_SCORES.JUMP_THREE;
    if (line.includes(`${opponentChar}${p.repeat(3)}0`) || line.includes(`0${p.repeat(3)}${opponentChar}`)) score += SCORE.THREE;
    
    if (line.includes(`00${p.repeat(2)}00`)) score += SCORE.OPEN_TWO;
    if (line.includes(`${opponentChar}${p.repeat(2)}000`) || line.includes(`000${p.repeat(2)}${opponentChar}`)) score += SCORE.TWO;
    
    return score;
}


function evaluateBoardLocal(player, b) {
    let playerScore = 0;
    let opponentScore = 0;
    const opp = player === BLACK ? WHITE : BLACK;
    // 横
    for (let y=0;y<BOARD_SIZE;y++){
        const line = b[y].join('');
        playerScore += evaluateLineLocal(line, player);
        opponentScore += evaluateLineLocal(line, opp);
    }
    // 縦
    for (let x=0;x<BOARD_SIZE;x++){
        let line = '';
        for (let y=0;y<BOARD_SIZE;y++) line += b[y][x];
        playerScore += evaluateLineLocal(line, player);
        opponentScore += evaluateLineLocal(line, opp);
    }
    // 斜め
    for (let i = 0; i < BOARD_SIZE * 2 - 1; i++) {
        let line1 = '', line2 = '';
        for (let j = 0; j <= i; j++) {
            const x1 = j, y1 = i - j;
            const x2 = j, y2 = BOARD_SIZE - 1 - (i - j);
            if (y1 < BOARD_SIZE && x1 < BOARD_SIZE) line1 += b[y1][x1];
            if (y2 >= 0 && x2 < BOARD_SIZE) line2 += b[y2][x2];
        }
        if(line1.length >= 5) {
            playerScore += evaluateLineLocal(line1, player);
            opponentScore += evaluateLineLocal(line1, opp);
        }
        if(line2.length >= 5) {
            playerScore += evaluateLineLocal(line2, player);
            opponentScore += evaluateLineLocal(line2, opp);
        }
    }
    return playerScore - opponentScore;
}



// --- 置換: getMoveScoreLocal ---
function getMoveScoreLocal(x, y, player, b) {
    const cacheKey = `${currentHash}:movescore:${player}:${x},${y}:h${history.length}`;
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey);


    let score = 0;


    // 盤/ハッシュの整合性のため makeMoveHash/undoMoveHash を使う
    makeMoveHash(x, y, player, history);
    try {
        const directions = [[1,0],[0,1],[1,1],[1,-1]];
        for (const [dx,dy] of directions) {
            let line = '';
            for (let i = -4; i <= 4; i++) {
                const nx = x + i*dx, ny = y + i*dy;
                if (inBounds(nx,ny)) line += b[ny][nx];
                else line += '3';
            }
            score += evaluateLineLocal(line, player);
        }
    } finally {
        undoMoveHash(history);
    }


    evalCache.set(cacheKey, score);
    return score;
}


/**
 * @description 【修正点 3】候補手生成ロジックを全面的に改善
 * - 攻撃と防御のスコアを同時に評価し、合算した総合スコアで手を序列付けする。
 * - これにより、攻防のバランスが取れた手を見つけやすくなる。
 */
// --- 置換: generateMovesLocal (limit 引数を追加) ---
function generateMovesLocal(player, b, hist, radius, limit = 30) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const candidates = generateCandidatesFromHistory(hist, radius);
    const scoredMoves = [];


    // 自分の即勝ちの手があれば、それを最優先
    const myWins = getImmediateWinningMovesLocal(player, b, hist, radius);
    if (myWins.length > 0) {
        return myWins.map(m => ({ x: m.x, y: m.y, score: SCORE.FIVE }));
    }


    // 相手の即勝ちを防ぐ手は次点
    const oppWins = getImmediateWinningMovesLocal(opponent, b, hist, radius);
    if (oppWins.length > 0) {
        if (oppWins.length === 1) {
            const blockMove = oppWins[0];
            return [{ x: blockMove.x, y: blockMove.y, score: SCORE.OPEN_FOUR * 2 }];
        }
        for (const move of oppWins) {
            candidates.unshift({ x: move.x, y: move.y });
        }
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
    // limit を適用（ルートなら大きめの limit を渡す）
    return scoredMoves.slice(0, limit);
}


function generateRootCandidates(player, b, hist, radius) {
    const opponent = player === BLACK ? WHITE : BLACK;
    const oppWinsBefore = getImmediateWinningMovesLocal(opponent, b, hist, radius).length;
    const oppOpenThreesBefore = getOpenThreeMovesLocal(opponent, b, hist, radius).length;


    // root ではより多めに候補を取り、探索切断リスクを低下させる（例: 80）
    const raw = generateMovesLocal(player, b, hist, radius, 80);
    const scored = [];
    for (const mv of raw) {
        const s = getMoveScoreLocal(mv.x, mv.y, player, b); // now getMoveScoreLocal uses makeMoveHash internally
        scored.push({ x: mv.x, y: mv.y, score: s });
    }
    scored.sort((a,b) => b.score - a.score);
    return scored.map(s => ({x: s.x, y: s.y, score: s.score}));
}



// --- 進捗通知 (変更なし) ---
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


// --- Quiescence (変更なし) ---
function quiescence(player, alpha, beta, b, hist, radius, qDepth) {
    if (qDepth <= 0) return evaluateBoardLocal(player, b);


    const timeLimit = Math.max(50, settings.timeLimit || 1200);
    if ((now() - startTimeGlobal) > timeLimit) return evaluateBoardLocal(player, b);


    nodesGlobal++;
    maybeReport();


    // 自分の即勝チェック
    const myWins = getImmediateWinningMovesLocal(player, b, hist, radius);
    if (myWins.length > 0) {
        return SCORE.FIVE;
    }


    const stand_pat = evaluateBoardLocal(player, b);
    if (stand_pat >= beta) return stand_pat;
    if (alpha < stand_pat) alpha = stand_pat;


    // 脅威となる手（相手の四、自分の活三、相手の活三など）を探索
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


// --- Negamax (TT統合、変更なし) --- 
function negamax(depth, alpha, beta, player, b, hist, radius) {
    nodesGlobal++;
    maybeReport();


    const ttKey = `${currentHash}:${depth}:${player}`;
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


// --- runAI (メイン処理) ---
function runAI() {
    initZobrist();
    currentHash = computeHashFromBoard(board);
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
    // 改善された検出関数を利用
    const cpuImmediate = getImmediateWinningMovesLocal(aiColor, board, history, radius);
    if (cpuImmediate.length > 0) {
        postMessage({ cmd: 'progress', log: '発見: CPU 即勝' });
        return { bestMove: cpuImmediate[0], depth: 0, nodes: 1, elapsed: now()-startTimeGlobal, bestScore: SCORE.FIVE };
    }


    const oppImmediate = getImmediateWinningMovesLocal(playerColor, board, history, radius);
    if (oppImmediate.length > 0) {
        if (oppImmediate.length === 1) {
             const block = oppImmediate[0];
            postMessage({ cmd: 'progress', log: '発見: 相手 単一即勝 -> ブロック' });
            return { bestMove: block, depth: 0, nodes: 1, elapsed: now()-startTimeGlobal, bestScore: SCORE.OPEN_FOUR * 2 };
        } else {
             // 相手に複数の勝ち筋がある場合、探索に任せるのが安全
            postMessage({ cmd: 'progress', log: '警告: 相手に複数の即勝手あり' });
        }
    }
    
    // --- 反復深化 ---
    let bestMove = null;
    let bestScore = -Infinity;
    let depth = 1;
    const MAX_SEARCH_DEPTH = 12;


    // 改善された候補生成関数を利用
    const rootCandidates = generateRootCandidates(aiColor, board, history, radius);
    if (rootCandidates.length === 0) {
        return { bestMove: null, depth:0, nodes:0, elapsed: now()-startTimeGlobal, bestScore: 0 };
    }
    bestMove = { x: rootCandidates[0].x, y: rootCandidates[0].y }; // 候補がない場合へのフォールバック


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
            makeMoveHash(cand.x, cand.y, aiColor, history);
            
            const res = negamax(depth - 1, -beta, -alpha, playerColor, board, history, radius);
            
            undoMoveHash(history);
            
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
            
            // 次の深さの探索のために、今回良かった手を先頭に並べ替える (PVS/Aspiration Window のための準備)
            const idx = rootCandidates.findIndex(c => c.x === bestMove.x && c.y === bestMove.y);
            if (idx > 0) {
                const top = rootCandidates.splice(idx, 1)[0];
                rootCandidates.unshift(top);
            }


            postMessage({ cmd: 'progress', depth, elapsed: now()-startTimeGlobal, nodes: nodesGlobal, nps: nodesGlobal/Math.max(0.001,(now()-startTimeGlobal)/1000), candidate: `(${bestMove.x},${bestMove.y})`, eval: bestScore, log: `深さ ${depth}: 最善手 (${bestMove.x},${bestMove.y}), 評価 ${bestScore}` });
        }


        if (bestScore >= SCORE.FIVE / 2) break; // 勝ちが確定したら探索終了
        depth++;
    }


    const elapsedTotal = now() - startTimeGlobal;
    return { bestMove, depth: depth-1, nodes: nodesGlobal, elapsed: elapsedTotal, bestScore };
}
