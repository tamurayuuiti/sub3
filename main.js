// main.js — PvP（プレイヤー対プレイヤー）専用版（勝率解析ボタンから worker に問い合わせ可能）
const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

let board = [];
let currentPlayer = BLACK; // 現在の手番（BLACK / WHITE）
let startSide = BLACK;     // ゲーム開始時の先手指定
let gameOver = true;
let history = [];

// 計算用設定（勝率解析に利用）
let aiSettings = {
    radius: 2,
    timeLimit: 1200,
    minDepth: 3,
    // PvP 勝率用設定（UI で調整可能）
    probScale: 2000000,
    computeBoth: false
};

let aiWorker = null; // 勝率計算用ワーカー（必要時のみ生成）

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
        cpuLog: document.getElementById('cpuLog'),
        paramsModal: document.getElementById('paramsModal'),
        paramsDetails: document.getElementById('paramsDetails'),
        showParams: document.getElementById('showParams'),
        closeModal: document.getElementById('closeModal'),
        computeProbBtn: document.getElementById('computeProbBtn'),
        probScale: document.getElementById('probScale'),
        computeBoth: document.getElementById('computeBoth')
    };
    initializeGame();
    startGame(startSide);
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
    if (dom.selectBlack) dom.selectBlack.addEventListener('click', () => startGame(BLACK));
    if (dom.selectWhite) dom.selectWhite.addEventListener('click', () => startGame(WHITE));
    if (dom.reset) dom.reset.addEventListener('click', resetGame);
    if (dom.undo) dom.undo.addEventListener('click', undoMove);

    if (dom.radius) {
        dom.radius.addEventListener('input', e => {
            aiSettings.radius = parseInt(e.target.value, 10);
            if (dom.radiusLabel) dom.radiusLabel.textContent = e.target.value;
        });
    }
    if (dom.time) {
        dom.time.addEventListener('input', e => {
            aiSettings.timeLimit = parseInt(e.target.value, 10);
            if (dom.timeLabel) dom.timeLabel.textContent = e.target.value;
        });
    }
    if (dom.minDepth) {
        dom.minDepth.addEventListener('input', e => {
            aiSettings.minDepth = Math.max(1, parseInt(e.target.value, 10));
            if (dom.minDepthLabel) dom.minDepthLabel.textContent = e.target.value;
        });
    }
    if (dom.probScale) {
        dom.probScale.addEventListener('change', e => {
            aiSettings.probScale = Math.max(1, Number(e.target.value) || 1);
        });
    }
    if (dom.computeBoth) {
        dom.computeBoth.addEventListener('change', e => {
            aiSettings.computeBoth = !!e.target.checked;
        });
    }

    if (dom.showParams) dom.showParams.addEventListener('click', showParameters);
    if (dom.closeModal) dom.closeModal.addEventListener('click', () => dom.paramsModal.classList.add('hidden'));
    if (dom.paramsModal) {
        dom.paramsModal.addEventListener('click', (e) => {
            if (e.target === dom.paramsModal) dom.paramsModal.classList.add('hidden');
        });
    }

    if (dom.computeProbBtn) dom.computeProbBtn.addEventListener('click', () => {
        updateMessage('局面勝率を計算しています...', 'thinking');
        computeWinProb();
    });
}

function resetGame() {
    // ワーカーは勝率計算時のみ生成するためここでは終了処理不要（念のため）
    terminateAIWorker();

    board = Array(BOARD_SIZE).fill(0).map(() => Array(BOARD_SIZE).fill(EMPTY));
    currentPlayer = startSide;
    gameOver = false;
    history = [];

    drawBoard();
    resetStats();
    updateMessage((currentPlayer === BLACK ? '黒' : '白') + 'の先手で開始しました。');
}

function resetStats() {
    if (dom.statDepth) dom.statDepth.textContent = '0';
    if (dom.statTime) dom.statTime.textContent = '0 ms';
    if (dom.statNodes) dom.statNodes.textContent = '0';
    if (dom.statNps) dom.statNps.textContent = '0';
    if (dom.statCandidates) dom.statCandidates.textContent = '—';
    if (dom.statEval) dom.statEval.textContent = '—';
    if (dom.cpuLog) dom.cpuLog.innerHTML = '';
}

function startGame(selectedColor) {
    // 新しいゲームを開始する（先手の色を指定）
    startSide = selectedColor;
    // リセットしてから開始
    board = Array(BOARD_SIZE).fill(0).map(() => Array(BOARD_SIZE).fill(EMPTY));
    history = [];
    gameOver = false;
    currentPlayer = startSide;

    if (dom.selectBlack) {
        dom.selectBlack.classList.toggle('bg-sky-600', startSide === BLACK);
        dom.selectBlack.classList.toggle('text-white', startSide === BLACK);
    }
    if (dom.selectWhite) {
        dom.selectWhite.classList.toggle('bg-sky-600', startSide === WHITE);
        dom.selectWhite.classList.toggle('text-white', startSide === WHITE);
    }

    drawBoard();
    resetStats();
    updateMessage((currentPlayer === BLACK ? '黒' : '白') + 'の番です。');
}

function handleCellClick(event) {
    if (gameOver) return;

    const cell = event.target.classList.contains('cell') ? event.target : event.target.closest('.cell');
    if (!cell || !cell.dataset.index) return;

    const index = parseInt(cell.dataset.index, 10);
    const x = index % BOARD_SIZE;
    const y = Math.floor(index / BOARD_SIZE);

    if (board[y][x] === EMPTY) {
        placeStone(x, y, currentPlayer);
    }
}

function placeStone(x, y, player) {
    if (gameOver) return;

    board[y][x] = player;
    history.push({ x, y, player });
    drawBoard();

    if (checkWin(x, y, player)) {
        gameOver = true;
        const winnerName = (player === BLACK) ? '黒' : '白';
        updateMessage(`${winnerName}の勝ちです！`, 'success');
        return;
    }

    // 手番交代
    currentPlayer = (player === BLACK) ? WHITE : BLACK;
    updateMessage((currentPlayer === BLACK ? '黒' : '白') + 'の番です。');
}

function undoMove() {
    if (history.length === 0 || gameOver) {
        logToCPU("取り消せる手がありません。", "error");
        return;
    }

    // 直近の1手を取り消す（どちらの手でもOK）
    const last = history.pop();
    board[last.y][last.x] = EMPTY;

    // 取り消した手のプレイヤーが再び手番になる
    currentPlayer = last.player;
    drawBoard();
    updateMessage((currentPlayer === BLACK ? '黒' : '白') + 'の番です（1手を取り消しました）。');
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
    if (!dom.message) return;
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
    if (!dom.cpuLog) return;
    const p = document.createElement('p');
    if (type === 'eval') p.classList.add('text-sky-700','font-semibold');
    p.textContent = message;
    dom.cpuLog.appendChild(p);
    dom.cpuLog.scrollTop = dom.cpuLog.scrollHeight;
}

function showParameters() {
    if (!dom.paramsDetails || !dom.paramsModal) return;
    dom.paramsDetails.innerHTML = `
        <p><strong>候補半径:</strong> ${aiSettings.radius}</p>
        <p><strong>思考時間/手:</strong> ${aiSettings.timeLimit} ms</p>
        <p><strong>最低探索深度 (minDepth):</strong> ${aiSettings.minDepth}</p>
        <p><strong>評価→勝率スケール:</strong> ${aiSettings.probScale}</p>
        <p><strong>両視点で評価 (computeBoth):</strong> ${aiSettings.computeBoth ? '有効' : '無効'}</p>
    `;
    dom.paramsModal.classList.remove('hidden');
    dom.paramsModal.classList.add('flex');
}

/* ---------- 勝率解析（worker 呼び出し） ---------- */

// 局面勝率を計算して結果を表示（ワーカーは必要時に生成して終了する）
function computeWinProb() {
    // ワーカーが既に動いている場合は先に終了
    terminateAIWorker();
    resetStats();

    try {
        aiWorker = new Worker('./aiWorker.js', { type: 'module' });
    } catch (err) {
        console.warn('Module worker を生成できません: ', err);
        try {
            aiWorker = new Worker('./aiWorker.js'); // フォールバック
        } catch (err2) {
            console.error('Worker 起動に失敗しました:', err2);
            updateMessage('ワーカーの起動に失敗しました。', 'error');
            return;
        }
    }

    aiWorker.onmessage = (e) => {
        const data = e.data;
        if (data.cmd === 'progress') {
            if (data.depth !== undefined && dom.statDepth) dom.statDepth.textContent = String(data.depth);
            if (data.elapsed !== undefined && dom.statTime) dom.statTime.textContent = `${Math.round(data.elapsed)} ms`;
            if (data.nodes !== undefined && dom.statNodes) dom.statNodes.textContent = String(data.nodes);
            if (data.nps !== undefined && dom.statNps) dom.statNps.textContent = String(Math.round(data.nps));
            if (data.candidate !== undefined && dom.statCandidates) dom.statCandidates.textContent = data.candidate;
            if (data.eval !== undefined && dom.statEval) dom.statEval.textContent = String(data.eval);
            if (data.log) logToCPU(data.log);
        } else if (data.cmd === 'result') {
            if (data.mode === 'pvpProb' || (typeof data.probBlack === 'number')) {
                const probBlack = data.probBlack;
                const probWhite = data.probWhite;
                const evalBlack = data.evalBlack;
                const msg = `勝率（推定） — 黒: ${(probBlack*100).toFixed(1)}% ／ 白: ${(probWhite*100).toFixed(1)}% (評価=${Math.round(evalBlack)})`;
                updateMessage(msg);
                logToCPU(msg, 'eval');
            } else {
                logToCPU('未知の結果形式を受信しました: ' + JSON.stringify(data), 'error');
            }
            terminateAIWorker();
        } else if (data.cmd === 'error') {
            logToCPU(`Worker error: ${data.message}`, 'error');
            terminateAIWorker();
        }
    };

    aiWorker.onerror = (err) => {
        console.error('Worker error', err);
        logToCPU('Worker でエラーが発生しました。コンソールを参照してください。', 'error');
        terminateAIWorker();
    };

    // settings に勝率用パラメータを渡す
    const payload = {
        cmd: 'think',
        board: board,
        settings: {
            mode: 'pvpProb',
            radius: aiSettings.radius,
            timeLimit: aiSettings.timeLimit,
            minDepth: aiSettings.minDepth,
            probScale: aiSettings.probScale,
            computeBoth: aiSettings.computeBoth
        },
        history: history
    };
    aiWorker.postMessage(payload);
}

// terminate worker
function terminateAIWorker() {
    if (aiWorker) {
        try { aiWorker.terminate(); } catch (e) {}
        aiWorker = null;
    }
}
