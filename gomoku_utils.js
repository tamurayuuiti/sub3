// gomoku_utils.js
// 共通ユーティリティ（ES module）
// 保存名例: gomoku_utils.js
// 使用例:
// import * as G from './gomoku_utils.js';
// const zobrist = G.createZobrist(15);
// const state = { board: G.deepCopyBoard(board), zobrist, currentHash: G.computeHashFromBoard(board, zobrist), history: [] };
// G.pushMove(state, x, y, player); G.popMove(state);

export const BOARD_SIZE_DEFAULT = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const SCORE = {
  FIVE: 10000000,
  OPEN_FOUR: 200000,
  FOUR: 40000,
  OPEN_THREE: 8000,
  THREE: 2000,
  OPEN_TWO: 200,
  TWO: 20,
  ONE: 1
};

export const PATTERN_SCORES = {
  JUMP_THREE: SCORE.THREE * 2
};

export const BONUS = {
  FORK: Math.floor(SCORE.OPEN_FOUR * 5),
  SINGLE_OPEN_FOUR: Math.floor(SCORE.OPEN_FOUR * 3),
  DOUBLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 12),
  SINGLE_OPEN_THREE: Math.floor(SCORE.OPEN_THREE * 3)
};

// --- 時刻取得 ---
export function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// --- 基本ユーティリティ ---
export function deepCopyBoard(b) {
  return b.map(row => row.slice());
}

export function inBounds(x, y, boardSize = BOARD_SIZE_DEFAULT) {
  return x >= 0 && x < boardSize && y >= 0 && y < boardSize;
}

// --- Zobrist helpers ---
export function rand32() {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * createZobrist(boardSize)
 * returns zobrist[y][x][pieceIndex] where pieceIndex: 0 unused, 1=BLACK, 2=WHITE
 */
export function createZobrist(boardSize = BOARD_SIZE_DEFAULT) {
  const zobrist = new Array(boardSize);
  for (let y = 0; y < boardSize; y++) {
    zobrist[y] = new Array(boardSize);
    for (let x = 0; x < boardSize; x++) {
      // [0, rand32(), rand32()] : index0 unused for clarity
      zobrist[y][x] = [0, rand32(), rand32()];
    }
  }
  return zobrist;
}

/**
 * computeHashFromBoard(board, zobrist)
 * board: 2D array of integers (0,1,2)
 * zobrist: produced by createZobrist
 */
export function computeHashFromBoard(board, zobrist) {
  let h = 0 >>> 0;
  const bs = board.length;
  for (let y = 0; y < bs; y++) {
    for (let x = 0; x < board[y].length; x++) {
      const v = board[y][x];
      if (v === BLACK || v === WHITE) h = (h ^ zobrist[y][x][v]) >>> 0;
    }
  }
  return h >>> 0;
}

/**
 * xorHashWithMove(currentHash, zobrist, x, y, player)
 * returns new hash (does not mutate)
 */
export function xorHashWithMove(currentHash, zobrist, x, y, player) {
  return (currentHash ^ zobrist[y][x][player]) >>> 0;
}

// --- board mutation helpers that operate on passed board / state object ---
// state: { board, zobrist, currentHash, history } where history is an array of {x,y,player}
export function pushMove(state, x, y, player) {
  // mutate board and history and hash inside state
  state.board[y][x] = player;
  state.history.push({ x, y, player });
  state.currentHash = xorHashWithMove(state.currentHash, state.zobrist, x, y, player);
  state.currentHash >>>= 0;
}

export function popMove(state) {
  const last = state.history.pop();
  if (!last) return null;
  state.board[last.y][last.x] = EMPTY;
  state.currentHash = xorHashWithMove(state.currentHash, state.zobrist, last.x, last.y, last.player);
  state.currentHash >>>= 0;
  return last;
}

// 直接ボードだけ操作する軽量関数（履歴やハッシュを扱わない場面で役立つ）
export function applyMove(board, x, y, player) {
  board[y][x] = player;
}
export function revertMove(board, x, y) {
  board[y][x] = EMPTY;
}


// --- 勝利判定（独立・純関数） ---
export function checkWin(board, x, y, player, boardSize = BOARD_SIZE_DEFAULT) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    let cnt = 1;
    for (let i = 1; i < 5; i++) {
      const nx = x + i * dx, ny = y + i * dy;
      if (inBounds(nx, ny, boardSize) && board[ny][nx] === player) cnt++; else break;
    }
    for (let i = 1; i < 5; i++) {
      const nx = x - i * dx, ny = y - i * dy;
      if (inBounds(nx, ny, boardSize) && board[ny][nx] === player) cnt++; else break;
    }
    if (cnt >= 5) return true;
  }
  return false;
}


// --- 候補生成（履歴ベース） ---
// board: 2D array, hist: [{x,y,player}, ...]
export function generateCandidatesFromHistory(board, hist = [], radius = 2, boardSize = BOARD_SIZE_DEFAULT) {
  const set = new Set();
  if (hist && hist.length > 0) {
    for (const mv of hist) {
      const baseX = mv.x, baseY = mv.y;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = baseX + dx, ny = baseY + dy;
          if (inBounds(nx, ny, boardSize) && board[ny][nx] === EMPTY) set.add((nx << 4) | ny);
        }
      }
    }
  } else {
    // 履歴が空なら既存石の周囲を探索
    for (let y = 0; y < boardSize; y++) {
      for (let x = 0; x < boardSize; x++) {
        if (board[y][x] === EMPTY) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx, ny = y + dy;
            if (inBounds(nx, ny, boardSize) && board[ny][nx] === EMPTY) set.add((nx << 4) | ny);
          }
        }
      }
    }
  }

  if (set.size === 0) {
    // 石が一つも無ければ中央を返す
    let anyStone = false;
    for (let y = 0; y < boardSize && !anyStone; y++) {
      for (let x = 0; x < boardSize; x++) if (board[y][x] !== EMPTY) { anyStone = true; break; }
    }
    if (!anyStone) {
      const c = Math.floor(boardSize / 2);
      return [{ x: c, y: c }];
    }
  }

  const arr = [];
  for (const key of set) arr.push({ x: key >> 4, y: key & 0xF });

  if (arr.length === 0) {
    for (let y = 0; y < boardSize; y++) for (let x = 0; x < boardSize; x++) if (board[y][x] === EMPTY) arr.push({ x, y });
  }

  return arr;
}


// ================================
// 評価関数（数値配列ベース）
// - evaluateLineArr(lineArr, player) : lineArr は整数配列（0,1,2,3）
// - evaluateBoard(board, player) : board は 2D 整数配列
// ================================

/**
 * evaluateLineArr(lineArr, player)
 * lineArr: 配列（値: 0=EMPTY,1=BLACK,2=WHITE,3=OUT）
 * player: BLACK or WHITE
 */
export function evaluateLineArr(lineArr, player) {
  const opponent = (player === BLACK) ? WHITE : BLACK;
  let score = 0;

  // 連続5（早期リターン）
  for (let i = 0; i + 5 <= lineArr.length; i++) {
    let ok = true;
    for (let j = 0; j < 5; j++) {
      if (lineArr[i + j] !== player) { ok = false; break; }
    }
    if (ok) return SCORE.FIVE;
  }

  // 長さ6窓判定
  for (let i = 0; i + 6 <= lineArr.length; i++) {
    const w0 = lineArr[i + 0], w1 = lineArr[i + 1], w2 = lineArr[i + 2], w3 = lineArr[i + 3], w4 = lineArr[i + 4], w5 = lineArr[i + 5];
    if (w0 === EMPTY && w1 === player && w2 === player && w3 === player && w4 === player && w5 === EMPTY) {
      score += SCORE.OPEN_FOUR;
    }
    if ((w0 === opponent && w1 === player && w2 === player && w3 === player && w4 === player && w5 === EMPTY) ||
        (w0 === EMPTY && w1 === player && w2 === player && w3 === player && w4 === player && w5 === opponent)) {
      score += SCORE.FOUR;
    }
    if ((w0 === EMPTY && w1 === player && w2 === EMPTY && w3 === player && w4 === player && w5 === EMPTY) ||
        (w0 === EMPTY && w1 === player && w2 === player && w3 === EMPTY && w4 === player && w5 === EMPTY)) {
      score += PATTERN_SCORES.JUMP_THREE;
    }
    if (w0 === EMPTY && w1 === EMPTY && w2 === player && w3 === player && w4 === EMPTY && w5 === EMPTY) {
      score += SCORE.OPEN_TWO;
    }
    if ((w0 === opponent && w1 === player && w2 === player && w3 === EMPTY && w4 === EMPTY && w5 === EMPTY) ||
        (w0 === EMPTY && w1 === EMPTY && w2 === EMPTY && w3 === player && w4 === player && w5 === opponent)) {
      score += SCORE.TWO;
    }
  }

  // 長さ5窓判定
  for (let i = 0; i + 5 <= lineArr.length; i++) {
    const a0 = lineArr[i + 0], a1 = lineArr[i + 1], a2 = lineArr[i + 2], a3 = lineArr[i + 3], a4 = lineArr[i + 4];
    if (a0 === EMPTY && a1 === player && a2 === player && a3 === player && a4 === EMPTY) score += SCORE.OPEN_THREE;
    if ((a0 === opponent && a1 === player && a2 === player && a3 === player && a4 === EMPTY) ||
        (a0 === EMPTY && a1 === player && a2 === player && a3 === player && a4 === opponent)) score += SCORE.THREE;
  }

  return score;
}


/**
 * evaluateBoard(board, player)
 * board: 2D array
 */
export function evaluateBoard(board, player) {
  let playerScore = 0;
  let opponentScore = 0;
  const opp = player === BLACK ? WHITE : BLACK;
  const boardSize = board.length;

  // 横
  for (let y = 0; y < boardSize; y++) {
    const lineArr = board[y].slice();
    playerScore += evaluateLineArr(lineArr, player);
    opponentScore += evaluateLineArr(lineArr, opp);
  }

  // 縦
  for (let x = 0; x < boardSize; x++) {
    const col = new Array(boardSize);
    for (let y = 0; y < boardSize; y++) col[y] = board[y][x];
    playerScore += evaluateLineArr(col, player);
    opponentScore += evaluateLineArr(col, opp);
  }

  // 斜め (\)
  for (let k = 0; k < boardSize * 2 - 1; k++) {
    const diag = [];
    for (let y = 0; y <= k; y++) {
      const x = k - y;
      if (y < boardSize && x < boardSize) diag.push(board[y][x]);
    }
    if (diag.length >= 5) {
      playerScore += evaluateLineArr(diag, player);
      opponentScore += evaluateLineArr(diag, opp);
    }
  }

  // 斜め (/)
  for (let k = 0; k < boardSize * 2 - 1; k++) {
    const diag = [];
    for (let y = 0; y <= k; y++) {
      const x = k - y;
      const yy = boardSize - 1 - y;
      if (yy >= 0 && yy < boardSize && x < boardSize) diag.push(board[yy][x]);
    }
    if (diag.length >= 5) {
      playerScore += evaluateLineArr(diag, player);
      opponentScore += evaluateLineArr(diag, opp);
    }
  }

  return playerScore - opponentScore;
}


// --- getImmediateWinningMoves (state-aware) ---
// state: { board, zobrist, currentHash, history }
// hist and radius same as generateCandidatesFromHistory
export function getImmediateWinningMoves(state, player, hist = state.history, radius = 2) {
  const wins = [];
  const board = state.board;
  const candidates = generateCandidatesFromHistory(board, hist, radius, board.length);

  for (const c of candidates) {
    const x = c.x, y = c.y;
    if (board[y][x] !== EMPTY) continue;
    pushMove(state, x, y, player);
    try {
      if (checkWin(board, x, y, player, board.length)) wins.push({ x, y });
    } finally {
      popMove(state);
    }
  }
  return wins;
}


/**
 * getOpenThreeMoves(state, player, hist, radius)
 * state-aware: uses push/pop to simulate moves
 */
export function getOpenThreeMoves(state, player, hist = state.history, radius = 2) {
  const moves = [];
  const board = state.board;
  const boardSize = board.length;
  const opponent = player === BLACK ? WHITE : BLACK;

  const candidates = generateCandidatesFromHistory(board, hist, radius, boardSize);
  for (const c of candidates) {
    const x = c.x, y = c.y;
    if (board[y][x] !== EMPTY) continue;
    pushMove(state, x, y, player);
    let hasOpenThree = false;
    try {
      const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (const [dx, dy] of directions) {
        const lineArr = [];
        for (let i = -5; i <= 5; i++) {
          const nx = x + i * dx, ny = y + i * dy;
          if (inBounds(nx, ny, boardSize)) lineArr.push(board[ny][nx]);
          else lineArr.push(3);
        }
        // check 5-window open three
        for (let s = 0; s + 5 <= lineArr.length; s++) {
          if (lineArr[s] === EMPTY && lineArr[s + 1] === player && lineArr[s + 2] === player && lineArr[s + 3] === player && lineArr[s + 4] === EMPTY) {
            hasOpenThree = true; break;
          }
        }
        if (hasOpenThree) break;
        // check 6-window jump three patterns
        for (let s = 0; s + 6 <= lineArr.length; s++) {
          const w0 = lineArr[s + 0], w1 = lineArr[s + 1], w2 = lineArr[s + 2], w3 = lineArr[s + 3], w4 = lineArr[s + 4], w5 = lineArr[s + 5];
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
  return moves;
}
