// AiClient.js
// AI Workerを管理し、メインスレッドとの仲介を行うクラス

export class AiClient {
  constructor(workerPath = './aiWorker.js') {
    this.workerPath = workerPath;
    this.worker = null;
    this.isThinking = false;
    
    // 中断時にPromiseを拒否(reject)するための関数を保持する変数
    this._currentReject = null; 

    this._initWorker();
  }

  // Workerの初期化・再起動
  _initWorker() {
    if (this.worker) {
      this.worker.terminate();
    }

    try {
      // type: module が重要（Worker内で import を使用しているため）
      this.worker = new Worker(this.workerPath, { type: 'module' });

      // 起動直後のロードエラー（404や構文エラー）を捕捉するためのリスナー
      this.worker.onerror = (e) => {
        console.error(`[AiClient] Worker起動エラー: ${e.message} (File: ${e.filename}, Line: ${e.lineno})`);
        this.isThinking = false;
        if (this._currentReject) {
            this._currentReject(new Error(`Worker startup failed: ${e.message}`));
            this._currentReject = null;
        }
      };

    } catch (err) {
      console.error("[AiClient] Worker生成に失敗しました:", err);
    }
  }

  /**
   * AIに思考を実行させる
   * @param {Object} params 
   * @param {Function} onProgress 
   * @returns {Promise}
   */
  async runAI(params, onProgress = null) {
    // すでに思考中なら強制終了してリセット
    if (this.isThinking) {
      console.warn("[AiClient] Previous thinking interrupted.");
      this.terminate(); 
    }

    this.isThinking = true;

    return new Promise((resolve, reject) => {
      // 1. terminate時にrejectできるように保持しておく
      this._currentReject = reject;

      // 2. メッセージハンドラの設定
      // onmessageへの代入は、前回のリスナーを上書きするので安全です
      this.worker.onmessage = (e) => {
        const data = e.data;

        if (data.cmd === 'result') {
          // 計算完了
          this.isThinking = false;
          this._currentReject = null; // 完了したので参照を消す
          resolve(data); 
        } 
        else if (data.cmd === 'progress') {
          // 進捗報告
          if (onProgress) onProgress(data);
        } 
        else if (data.cmd === 'error') {
          // Worker内部でのエラー
          this.isThinking = false;
          this._currentReject = null;
          reject(new Error(data.message));
        }
      };

      // 実行時エラーハンドラ
      this.worker.onerror = (err) => {
        this.isThinking = false;
        this._currentReject = null;
        reject(err);
      };

      // 3. Workerへ思考開始命令を送信
      this.worker.postMessage({
        cmd: 'think',
        board: params.board,
        playerColor: params.playerColor,
        aiColor: params.aiColor,
        history: params.history,
        settings: params.settings
      });
    });
  }

  /**
   * AIの思考を強制終了する
   * (リセットボタンや、待ったボタンが押された時に呼ぶ)
   */
  terminate() {
    // もし思考中で、待機しているPromiseがあれば、エラーとして終わらせる
    if (this._currentReject) {
        this._currentReject('Terminated'); // main.jsのcatchブロックに飛ぶ
        this._currentReject = null;
    }

    if (this.worker) {
      this.worker.terminate();
    }
    
    this.isThinking = false;
    this._initWorker(); // 次回のために再生成
  }
}
