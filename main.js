// main.js — UI / オーケストレーション（進捗をよりリアルタイムに反映）

const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

let board = [];
let currentPlayer = BLACK;
let playerColor = BLACK;
let aiColor = WHITE;
let gameOver = true;
let history = [];

let aiSettings = {
    radius: 2,
    timeLimit: 1200,
    minDepth: 3
};

let aiWorker = null;
let aiThinkingProcess = null;

let dom = {};
document.addEventListener('DOMContentLoaded', () => {
    dom = {
        board: document.getElementById('board'),
        message: document.getElementById('message'),
        selectBlack: document.getElementById('select-black'),
        selectWhite: document.getElementById('select-white'),
        reset: document.getElementById('reset'),
        undo: document.getElementById('undo'),
        radius: document.getElementById('radius'),
        radiusLabel: document.getElementById('radiusLabel'),
        time: document.getElementById('time'),
        timeLabel: document.getElementById('timeLabel'),
        minDepth: document.getElementById('minDepth'),
        minDepthLabel: document.getElementById('minDepthLabel'),
        statDepth: document.getElementById('stat-depth'),
        statTime: document.getElementById('stat-time'),
        statNodes: document.getElementById('stat-nodes'),
        statNps: document.getElementById('stat-nps'),
        statCandidates: document.getElementById('stat-candidates'),
        statEval: document.getElementById('stat-eval'),
        progressBar: document.getElementById('progressBar'),
        progressFill: document.getElementById('progressFill'),
        cpuLog: document.getElementById('cpuLog'),
        paramsModal: document.getElementById('paramsModal'),
        paramsDetails: document.getElementById('paramsDetails'),
        showParams: document.getElementById('showParams'),
        closeModal: document.getElementById('closeModal'),
    };
    initializeGame();
    startGame(BLACK);
});

function initializeGame() {
    createBoard();
    addEventListeners();
    resetGame();
}

function createBoard() {
    dom.board.innerHTML = '';
    for (let i = 0; i < BOARD_SIZE * BOARD_SIZE; i++) {
        const cell = document.createElement('div');
        cell.classList.add('cell');
        cell.dataset.index = i;
        cell.addEventListener('click', handleCellClick);
        dom.board.appendChild(cell);
    }
}

function addEventListeners() {
    dom.selectBlack.addEventListener('click', () => startGame(BLACK));
    dom.selectWhite.addEventListener('click', () => startGame(WHITE));
    dom.reset.addEventListener('click', resetGame);
    dom.undo.addEventListener('click', undoMove);

    dom.radius.addEventListener('input', e => {
        aiSettings.radius = parseInt(e.target.value);
        dom.radiusLabel.textContent = e.target.value;
    });
    dom.time.addEventListener('input', e => {
        aiSettings.timeLimit = parseInt(e.target.value);
        dom.timeLabel.textContent = e.target.value;
    });
    if (dom.minDepth) {
        dom.minDepth.addEventListener('input', e => {
            aiSettings.minDepth = Math.max(1, parseInt(e.target.value, 10));
            dom.minDepthLabel.textContent = e.target.value;
        });
    }
    dom.showParams.addEventListener('click', showParameters);
    dom.closeModal.addEventListener('click', () => dom.paramsModal.classList.add('hidden'));
    dom.paramsModal.addEventListener('click', (e) => {
        if (e.target === dom.paramsModal) dom.paramsModal.classList.add('hidden');
    });
}

function resetGame() {
    terminateAIWorker();
    board = Array(BOARD_SIZE).fill(0).map(() => Array(BOARD_SIZE).fill(EMPTY));
    currentPlayer = BLACK;
    gameOver = false;
    history = [];

    drawBoard();
    resetStats();
    startGame(playerColor);
}

function resetStats() {
    dom.statDepth.textContent = '0';
    dom.statTime.textContent = '0 ms';
    dom.statNodes.textContent = '0';
    dom.statNps.textContent = '0';
    dom.statCandidates.textContent = '—';
    dom.statEval.textContent = '—';
    // 進捗バー関連の処理を削除
    if (dom.cpuLog) dom.cpuLog.innerHTML = '';
}

function startGame(selectedColor) {
    if (!gameOver || history.length > 0) {
        terminateAIWorker();
        board = Array(BOARD_SIZE).fill(0).map(() => Array(BOARD_SIZE).fill(EMPTY));
        history = [];
        drawBoard();
        resetStats();
    }
    playerColor = selectedColor;
    aiColor = (playerColor === BLACK) ? WHITE : BLACK;
    gameOver = false;
    currentPlayer = BLACK;

    dom.selectBlack.classList.toggle('bg-sky-600', playerColor === BLACK);
    dom.selectBlack.classList.toggle('text-white', playerColor === BLACK);
    dom.selectWhite.classList.toggle('bg-sky-600', playerColor === WHITE);
    dom.selectWhite.classList.toggle('text-white', playerColor === WHITE);

    if (playerColor === WHITE) {
        updateMessage('CPUが考えています...', 'thinking');
        const center = Math.floor(BOARD_SIZE / 2);
        setTimeout(() => placeStone(center, center, BLACK), 500);
    } else {
        updateMessage('あなたの番です。石を置いてください。');
    }
}

function handleCellClick(event) {
    if (gameOver || currentPlayer !== playerColor || aiThinkingProcess) return;

    const cell = event.target.classList.contains('cell') ? event.target : event.target.closest('.cell');
    if (!cell || !cell.dataset.index) return;

    const index = parseInt(cell.dataset.index);
    const x = index % BOARD_SIZE;
    const y = Math.floor(index / BOARD_SIZE);

    if (board[y][x] === EMPTY) placeStone(x, y, playerColor);
}

function placeStone(x, y, player) {
    if (gameOver) return;

    board[y][x] = player;
    history.push({x, y, player});
    drawBoard();

    if (checkWin(x, y, player)) {
        gameOver = true;
        const winner = player === playerColor ? 'あなた' : 'CPU';
        updateMessage(`${winner}の勝ちです！`, 'success');
        terminateAIWorker();
        return;
    }

    currentPlayer = (player === BLACK) ? WHITE : BLACK;

    if (currentPlayer === aiColor) {
        updateMessage('CPUが考えています...', 'thinking');
        startAIWorker();
    } else {
        updateMessage('あなたの番です。');
    }
}

function undoMove() {
    if (history.length < 2 || gameOver || currentPlayer !== playerColor) {
        logToCPU("待ったはできません。", "error");
        return;
    }

    terminateAIWorker();

    const aiLastMove = history.pop();
    board[aiLastMove.y][aiLastMove.x] = EMPTY;

    const playerLastMove = history.pop();
    board[playerLastMove.y][playerLastMove.x] = EMPTY;

    currentPlayer = playerColor;
    drawBoard();
    updateMessage('あなたの番です。');
}

function checkWin(x, y, player) {
    const dirs = [[1,0],[0,1],[1,1],[1,-1]];
    for (const [dx,dy] of dirs) {
        let cnt = 1;
        for (let i=1;i<5;i++){
            const nx = x + i*dx, ny = y + i*dy;
            if (nx>=0 && nx<BOARD_SIZE && ny>=0 && ny<BOARD_SIZE && board[ny][nx] === player) cnt++; else break;
        }
        for (let i=1;i<5;i++){
            const nx = x - i*dx, ny = y - i*dy;
            if (nx>=0 && nx<BOARD_SIZE && ny>=0 && ny<BOARD_SIZE && board[ny][nx] === player) cnt++; else break;
        }
        if (cnt >= 5) return true;
    }
    return false;
}

function drawBoard() {
    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            const index = y * BOARD_SIZE + x;
            const cell = dom.board.children[index];
            const existingStone = cell.querySelector('.stone');
            if (existingStone) existingStone.remove();
            if (board[y][x] !== EMPTY) {
                const stone = document.createElement('div');
                stone.classList.add('stone', board[y][x] === BLACK ? 'stone-black' : 'stone-white');
                cell.appendChild(stone);
            }
        }
    }
}

function updateMessage(msg, type = 'info') {
    dom.message.textContent = msg;
    dom.message.className = 'mb-3 p-2 rounded text-center font-semibold';
    if (type === 'thinking') {
        dom.message.innerHTML = `
            <div class="thinking">${msg}<div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
        dom.message.classList.add('bg-yellow-50','text-yellow-700');
    } else if (type === 'success') {
        dom.message.classList.add('bg-green-50','text-green-700');
    } else if (type === 'error') {
        dom.message.classList.add('bg-red-50','text-red-700');
    } else {
        dom.message.classList.add('bg-indigo-50','text-indigo-700');
    }
}

function logToCPU(message, type = 'info') {
    const p = document.createElement('p');
    if(type === 'eval') p.classList.add('text-sky-700','font-semibold');
    p.textContent = message;
    dom.cpuLog.appendChild(p);
    dom.cpuLog.scrollTop = dom.cpuLog.scrollHeight;
}

function showParameters() {
    dom.paramsDetails.innerHTML = `
        <p><strong>候補半径:</strong> ${aiSettings.radius}</p>
        <p><strong>思考時間/手:</strong> ${aiSettings.timeLimit} ms</p>
        <p><strong>最低探索深度 (minDepth):</strong> ${aiSettings.minDepth}</p>
    `;
    dom.paramsModal.classList.remove('hidden');
    dom.paramsModal.classList.add('flex');
}

/* Worker 管理 */
function startAIWorker() {
    terminateAIWorker();
    resetStats(); // 統計情報をリセット
    aiWorker = new Worker('aiWorker.js');

    aiWorker.onmessage = (e) => {
        const data = e.data;
        if (data.cmd === 'progress') {
            // 統計情報の更新をより確実に
            if (data.depth !== undefined) dom.statDepth.textContent = String(data.depth);
            if (data.elapsed !== undefined) dom.statTime.textContent = `${Math.round(data.elapsed)} ms`;
            if (data.nodes !== undefined) dom.statNodes.textContent = String(data.nodes);
            if (data.nps !== undefined) dom.statNps.textContent = String(Math.round(data.nps));
            if (data.candidate !== undefined) dom.statCandidates.textContent = data.candidate;
            // 評価値の表示を改善
            if (data.eval !== undefined) {
                const evalScore = data.eval;
                // スコアの表示形式を整える
                if (Math.abs(evalScore) >= 1000000) {
                    dom.statEval.textContent = evalScore > 0 ? '必勝' : '必敗';
                } else {
                    dom.statEval.textContent = String(evalScore);
                }
                // スコアに応じて色分けする
                dom.statEval.className = 'font-medium ' + 
                    (evalScore > 1000 ? 'text-green-600' : 
                     evalScore < -1000 ? 'text-red-600' : 'text-gray-900');
            }
            if (data.log) logToCPU(data.log);
        } else if (data.cmd === 'result') {
            const bm = data.bestMove;
            if (bm && typeof bm.x === 'number') {
                // 最終評価値も含めてログに記録
                logToCPU(`探索完了: 深さ=${data.depth}, 探索数=${data.nodes}, 時間=${Math.round(data.elapsed)}ms, 最善手=(${bm.x},${bm.y}), 評価値=${data.eval}`, 'eval');
                placeStone(bm.x, bm.y, aiColor);
            } else {
                updateMessage('AIが有効な手を見つけられませんでした。', 'error');
                currentPlayer = playerColor;
            }
            terminateAIWorker();
        } else if (data.cmd === 'error') {
            logToCPU(`Worker error: ${data.message}`, 'error');
            terminateAIWorker();
            currentPlayer = playerColor;
        }
    };

    aiWorker.onerror = (err) => {
        console.error('Worker error', err);
        logToCPU('Worker でエラーが発生しました。コンソールを参照してください。', 'error');
        terminateAIWorker();
        currentPlayer = playerColor;
    };

    const payload = {
        cmd: 'think',
        board: board,
        settings: { ...aiSettings },
        playerColor,
        aiColor,
        history
    };
    aiWorker.postMessage(payload);
    aiThinkingProcess = aiWorker;
}

function terminateAIWorker() {
    if (aiWorker) {
        try { aiWorker.terminate(); } catch (e) {}
        aiWorker = null;
    }
    aiThinkingProcess = null;
}
