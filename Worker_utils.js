// Worker_utils.js（最適化版）
// 副作用のある関数（pushMove/popMove/getImmediateWinningMoves/getOpenThreeMoves）は
// このファイルから除外しています。下に戻すべき関数として別途示します。

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

// --- 時刻取得（そのまま） ---
export function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// --- 基本ユーティリティ ---
export function deepCopyBoard(b) {
  // row.slice をローカル化して少し高速化
  const out = new Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i].slice();
  return out;
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
    const row = new Array(boardSize);
    for (let x = 0; x < boardSize; x++) {
      row[x] = [0, rand32(), rand32()];
    }
    zobrist[y] = row;
  }
  return zobrist;
}

/**
 * computeHashFromBoard(board, zobrist)
 * board: 2D array of integers (0,1,2)
 */
export function computeHashFromBoard(board, zobrist) {
  let h = 0 >>> 0;
  const bs = board.length;
  for (let y = 0; y < bs; y++) {
    const row = board[y];
    const zrow = zobrist[y];
    for (let x = 0, lx = row.length; x < lx; x++) {
      const v = row[x];
      // v を数値比較するだけなのでインラインで高速
      if (v === BLACK || v === WHITE) h = (h ^ zrow[x][v]) >>> 0;
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

// 直接ボードだけ操作する軽量関数（履歴やハッシュを扱わない場面で役立つ）
export function applyMove(board, x, y, player) {
  board[y][x] = player;
}
export function revertMove(board, x, y) {
  board[y][x] = EMPTY;
}


// --- 勝利判定（純粋関数） ---
export function checkWin(board, x, y, player, boardSize = BOARD_SIZE_DEFAULT) {
  // 局所化で少し高速化
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let d = 0; d < 4; d++) {
    const dx = dirs[d][0], dy = dirs[d][1];
    let cnt = 1;
    for (let i = 1; i < 5; i++) {
      const nx = x + i * dx, ny = y + i * dy;
      if (nx >= 0 && nx < boardSize && ny >= 0 && ny < boardSize && board[ny][nx] === player) cnt++; else break;
    }
    for (let i = 1; i < 5; i++) {
      const nx = x - i * dx, ny = y - i * dy;
      if (nx >= 0 && nx < boardSize && ny >= 0 && ny < boardSize && board[ny][nx] === player) cnt++; else break;
    }
    if (cnt >= 5) return true;
  }
  return false;
}


// --- 候補生成（履歴ベース） ---
// board: 2D array, hist: [{x,y,player}, ...]
export function generateCandidatesFromHistory(board, hist = [], radius = 2, boardSize = BOARD_SIZE_DEFAULT) {
  // key を nx*boardSize + ny にして、boardSize 拡張に対応（以前は nx<<4 | ny）
  const set = new Set();
  const bs = boardSize;

  if (hist && hist.length > 0) {
    for (let i = 0; i < hist.length; i++) {
      const mv = hist[i];
      const baseX = mv.x, baseY = mv.y;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = baseY + dy;
        if (ny < 0 || ny >= bs) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = baseX + dx;
          if (nx < 0 || nx >= bs) continue;
          if (board[ny][nx] === EMPTY) set.add(nx * bs + ny);
        }
      }
    }
  } else {
    // 履歴が空でも「既存石の周囲」を探索（局所化）
    for (let y = 0; y < bs; y++) {
      const row = board[y];
      for (let x = 0; x < bs; x++) {
        if (row[x] === EMPTY) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= bs) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= bs) continue;
            if (board[ny][nx] === EMPTY) set.add(nx * bs + ny);
          }
        }
      }
    }
  }

  if (set.size === 0) {
    // 石が一つも無ければ中央を返す
    let anyStone = false;
    for (let y = 0; y < boardSize && !anyStone; y++) {
      const row = board[y];
      for (let x = 0; x < boardSize; x++) if (row[x] !== EMPTY) { anyStone = true; break; }
    }
    if (!anyStone) {
      const c = Math.floor(boardSize / 2);
      return [{ x: c, y: c }];
    }
  }

  const out = [];
  for (const key of set) {
    const nx = Math.floor(key / boardSize);
    const ny = key % boardSize;
    out.push({ x: nx, y: ny });
  }

  if (out.length === 0) {
    for (let y = 0; y < boardSize; y++) for (let x = 0; x < boardSize; x++) if (board[y][x] === EMPTY) out.push({ x, y });
  }

  return out;
}


// ================================
// 評価関数（数値配列ベース）
// - evaluateLineArr(lineArr, player) : lineArr は整数配列（0,1,2,3）
// - evaluateBoard(board, player) : board は 2D 整数配列
// ================================

export function evaluateLineArr(lineArr, player) {
  const opponent = (player === BLACK) ? WHITE : BLACK;
  let score = 0;
  const L = lineArr.length;

  // 連続5（早期リターン） — 局所化して高速化
  for (let i = 0, imax = L - 5 + 1; i < imax; i++) {
    if (lineArr[i] === player && lineArr[i+1] === player && lineArr[i+2] === player && lineArr[i+3] === player && lineArr[i+4] === player) {
      return SCORE.FIVE;
    }
  }

  // 長さ6窓判定
  for (let i = 0, imax = L - 6 + 1; i < imax; i++) {
    const w0 = lineArr[i], w1 = lineArr[i+1], w2 = lineArr[i+2], w3 = lineArr[i+3], w4 = lineArr[i+4], w5 = lineArr[i+5];
    if (w0 === EMPTY && w1 === player && w2 === player && w3 === player && w4 === player && w5 === EMPTY) {
      score += SCORE.OPEN_FOUR;
    } else if ((w0 === opponent && w1 === player && w2 === player && w3 === player && w4 === player && w5 === EMPTY) ||
               (w0 === EMPTY && w1 === player && w2 === player && w3 === player && w4 === player && w5 === opponent)) {
      score += SCORE.FOUR;
    } else if ((w0 === EMPTY && w1 === player && w2 === EMPTY && w3 === player && w4 === player && w5 === EMPTY) ||
               (w0 === EMPTY && w1 === player && w2 === player && w3 === EMPTY && w4 === player && w5 === EMPTY)) {
      score += PATTERN_SCORES.JUMP_THREE;
    } else if (w0 === EMPTY && w1 === EMPTY && w2 === player && w3 === player && w4 === EMPTY && w5 === EMPTY) {
      score += SCORE.OPEN_TWO;
    } else if ((w0 === opponent && w1 === player && w2 === player && w3 === EMPTY && w4 === EMPTY && w5 === EMPTY) ||
               (w0 === EMPTY && w1 === EMPTY && w2 === EMPTY && w3 === player && w4 === player && w5 === opponent)) {
      score += SCORE.TWO;
    }
  }

  // 長さ5窓判定
  for (let i = 0, imax = L - 5 + 1; i < imax; i++) {
    const a0 = lineArr[i], a1 = lineArr[i+1], a2 = lineArr[i+2], a3 = lineArr[i+3], a4 = lineArr[i+4];
    if (a0 === EMPTY && a1 === player && a2 === player && a3 === player && a4 === EMPTY) score += SCORE.OPEN_THREE;
    else if ((a0 === opponent && a1 === player && a2 === player && a3 === player && a4 === EMPTY) ||
             (a0 === EMPTY && a1 === player && a2 === player && a3 === player && a4 === opponent)) score += SCORE.THREE;
  }

  return score;
}

export function evaluateBoard(board, player) {
  let playerScore = 0;
  let opponentScore = 0;
  const opp = player === BLACK ? WHITE : BLACK;
  const boardSize = board.length;

  // 横
  for (let y = 0; y < boardSize; y++) {
    const row = board[y].slice();
    playerScore += evaluateLineArr(row, player);
    opponentScore += evaluateLineArr(row, opp);
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
