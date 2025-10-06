// main.js — PvP（プレイヤー対プレイヤー）専用版（石を置いたら自動で勝率解析、解析中は操作をブロック）
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
let computing = false; // true = 勝率解析中（クリック等をブロック）

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
        computeBoth: document.getElementById('computeBoth'),
        // チャートコンテナ（自動生成もする）
        probChartContainer: document.getElementById('probChartContainer')
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
    if (!dom.board) return;
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
    if (dom.undo) dom.undo.addEventListener('click', () => {
        if (computing) {
            logToCPU('解析中は取り消せません。', 'error');
            return;
        }
        undoMove();
    });

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
        // 手動トリガー（石を置かずに解析したい場合）
        if (computing) {
            logToCPU('既に解析中です。', 'error');
            return;
        }
        updateMessage('局面勝率を計算しています...', 'thinking');
        startComputeWithBlock();
    });
}

// startGame, resetGame
function resetGame() {
    terminateAIWorker();
    computing = false;

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
    clearProbChart();
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

// クリックハンドラ — 解析中はブロック
function handleCellClick(event) {
    if (gameOver || computing) {
        if (computing) logToCPU('解析中は石を置けません。', 'error');
        return;
    }

    const cell = event.target.classList.contains('cell') ? event.target : event.target.closest('.cell');
    if (!cell || !cell.dataset.index) return;

    const index = parseInt(cell.dataset.index, 10);
    const x = index % BOARD_SIZE;
    const y = Math.floor(index / BOARD_SIZE);

    if (board[y][x] === EMPTY) {
        placeStone(x, y, currentPlayer);
        // 石を置いた直後に自動で勝率計算を開始（解析中は内部でブロック）
        startComputeWithBlock();
    }
}

function placeStone(x, y, player) {
    if (gameOver || computing) return;

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
    if (computing) {
        logToCPU("解析中は取り消せません。", "error");
        return;
    }
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
    if (!dom.board) return;
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

// helper: ブロックを有効化してから compute を開始
function startComputeWithBlock() {
    if (computing) return;
    computing = true;
    // disable board interactions visually & functionally
    if (dom.board) dom.board.style.pointerEvents = 'none';
    if (dom.computeProbBtn) dom.computeProbBtn.disabled = true;
    if (dom.undo) dom.undo.disabled = true;
    updateMessage('解析中... 終了まで操作はできません', 'thinking');

    // ensure aiSettings updated from UI inputs (if any)
    if (dom.probScale) aiSettings.probScale = Math.max(1, Number(dom.probScale.value) || aiSettings.probScale);
    if (dom.computeBoth) aiSettings.computeBoth = !!dom.computeBoth.checked;

    computeWinProb();
}

// 局面勝率を計算して結果を表示（ワーカーは必要時に生成して終了する）
function computeWinProb() {
    terminateAIWorker(); // 安全に前のワーカーを終了
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
            computing = false;
            if (dom.board) dom.board.style.pointerEvents = '';
            if (dom.computeProbBtn) dom.computeProbBtn.disabled = false;
            if (dom.undo) dom.undo.disabled = false;
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
            // 結果受信 — 勝率 (pvpProb) 形式を期待
            if (data.mode === 'pvpProb' || (typeof data.probBlack === 'number')) {
                const probBlack = data.probBlack;
                const probWhite = data.probWhite;
                const evalBlack = data.evalBlack;
                const msg = `勝率（推定） — 黒: ${(probBlack*100).toFixed(1)}% ／ 白: ${(probWhite*100).toFixed(1)}% (評価=${Math.round(evalBlack)})`;
                updateMessage(msg);
                logToCPU(msg, 'eval');
                drawProbChart(probBlack, probWhite);
            } else {
                logToCPU('未知の結果形式を受信しました: ' + JSON.stringify(data), 'error');
                updateMessage('解析結果の形式が不明です。', 'error');
            }
            // 後処理：操作を再許可
            computing = false;
            if (dom.board) dom.board.style.pointerEvents = '';
            if (dom.computeProbBtn) dom.computeProbBtn.disabled = false;
            if (dom.undo) dom.undo.disabled = false;
            terminateAIWorker();
        } else if (data.cmd === 'error') {
            logToCPU(`Worker error: ${data.message}`, 'error');
            updateMessage('ワーカーでエラーが発生しました。', 'error');
            computing = false;
            if (dom.board) dom.board.style.pointerEvents = '';
            if (dom.computeProbBtn) dom.computeProbBtn.disabled = false;
            if (dom.undo) dom.undo.disabled = false;
            terminateAIWorker();
        }
    };

    aiWorker.onerror = (err) => {
        console.error('Worker error', err);
        logToCPU('Worker でエラーが発生しました。コンソールを参照してください。', 'error');
        updateMessage('ワーカーでエラーが発生しました。', 'error');
        computing = false;
        if (dom.board) dom.board.style.pointerEvents = '';
        if (dom.computeProbBtn) dom.computeProbBtn.disabled = false;
        if (dom.undo) dom.undo.disabled = false;
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

/* ---------- 簡易円グラフ（SVG）描画 ---------- */

function ensureProbChartContainer() {
    if (!dom.probChartContainer) {
        // try to find existing element by id; if none, create under cpuLog or message
        let container = document.getElementById('probChartContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'probChartContainer';
            container.style.marginTop = '10px';
            // prefer placing under cpuLog; fallback to message container
            if (dom.cpuLog && dom.cpuLog.parentNode) dom.cpuLog.parentNode.appendChild(container);
            else if (dom.message && dom.message.parentNode) dom.message.parentNode.appendChild(container);
            else document.body.appendChild(container);
        }
        dom.probChartContainer = container;
    }
}

function clearProbChart() {
    ensureProbChartContainer();
    dom.probChartContainer.innerHTML = '';
}

function drawProbChart(probBlack, probWhite) {
    ensureProbChartContainer();
    dom.probChartContainer.innerHTML = ''; // clear previous

    // clamp
    probBlack = Math.max(0, Math.min(1, Number(probBlack) || 0));
    probWhite = Math.max(0, Math.min(1, Number(probWhite) || 0));

    const size = 140;
    const cx = size/2, cy = size/2, r = size/2 - 6;

    // build SVG
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.style.display = 'block';
    svg.style.margin = '0 auto';

    // helper: polar to cartesian
    function polarToCartesian(cx, cy, r, angleDeg) {
        const a = (angleDeg - 90) * Math.PI / 180.0;
        return { x: cx + (r * Math.cos(a)), y: cy + (r * Math.sin(a)) };
    }
    function describeArc(cx, cy, r, startAngle, endAngle) {
        const start = polarToCartesian(cx, cy, r, endAngle);
        const end = polarToCartesian(cx, cy, r, startAngle);
        const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
        return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
    }

    const angleBlack = probBlack * 360;
    const angleWhite = probWhite * 360;

    // black slice
    const pathBlack = document.createElementNS(svgNS, 'path');
    pathBlack.setAttribute('d', describeArc(cx, cy, r, 0, angleBlack));
    pathBlack.setAttribute('fill', '#111');
    svg.appendChild(pathBlack);

    // white slice (start at angleBlack to 360)
    const pathWhite = document.createElementNS(svgNS, 'path');
    pathWhite.setAttribute('d', describeArc(cx, cy, r, angleBlack, angleBlack + angleWhite));
    pathWhite.setAttribute('fill', '#fff');
    pathWhite.setAttribute('stroke', '#333');
    svg.appendChild(pathWhite);

    // inner circle to make donut
    const donut = document.createElementNS(svgNS, 'circle');
    donut.setAttribute('cx', String(cx));
    donut.setAttribute('cy', String(cy));
    donut.setAttribute('r', String(Math.max(0, r - 28)));
    donut.setAttribute('fill', '#fff');
    svg.appendChild(donut);

    // center text
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', String(cx));
    text.setAttribute('y', String(cy));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-size', '12');
    text.setAttribute('font-weight', '600');
    text.textContent = `${(probBlack*100).toFixed(1)}% / ${(probWhite*100).toFixed(1)}%`;
    svg.appendChild(text);

    // legend
    const legend = document.createElement('div');
    legend.style.display = 'flex';
    legend.style.justifyContent = 'center';
    legend.style.gap = '12px';
    legend.style.marginTop = '8px';
    legend.style.fontSize = '13px';

    const legendBlack = document.createElement('div');
    legendBlack.innerHTML = `<span style="display:inline-block;width:12px;height:12px;background:#111;border-radius:2px;margin-right:6px;vertical-align:middle;"></span>黒 ${(probBlack*100).toFixed(1)}%`;
    const legendWhite = document.createElement('div');
    legendWhite.innerHTML = `<span style="display:inline-block;width:12px;height:12px;background:#fff;border:1px solid #333;border-radius:2px;margin-right:6px;vertical-align:middle;"></span>白 ${(probWhite*100).toFixed(1)}%`;

    dom.probChartContainer.appendChild(svg);
    dom.probChartContainer.appendChild(legend);
    legend.appendChild(legendBlack);
    legend.appendChild(legendWhite);
}
