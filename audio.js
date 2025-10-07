/* global createC2Enc, createC2Dec */
// AudioEngine: микрофон, VU, Codec2 (encode/decode), RX-воспроизведение.
// Совместим с существующим main.js и index.html.

(function (global) {
  // ===== Константы =====
  const C2_RATE = 8000;           // Codec2 всегда 8 кГц
  const TX_BLOCK_SEC = 0.25;      // длительность кодируемого блока
  const HP_FC_HZ = 120;           // срез простого high-pass/DC-block
  const PREEMPH_A = 0.0;          // 0..0.97 (0 = выкл). Можно поставить 0.97 при очень низком битрейте

  class AudioEngine {
    constructor(opts = {}) {
      // ==== Колбэки ====
      this.onMicVu = opts.onMicVu || (() => {});               // (level 0..1)
      this.onRxVu = opts.onRxVu || (() => {});                 // (level 0..1) — с внутренним затуханием
      this.onTxStateChange = opts.onTxStateChange || (()=>{}); // (boolean) — активна ли TX (PTT)
      this.onEncodedFrame = opts.onEncodedFrame || (() => {}); // (Uint8Array) — отдать наружу для UART
      this.codecModeProvider = opts.codecModeProvider || (() => "1300");

      // ==== Конфигурация захвата ====
      this.defaultNoiseSuppression = opts.noiseSuppression ?? true;
      this.defaultEchoCancellation = opts.echoCancellation ?? true;

      // ==== TX состояние ====
      this.sendEnabled = false;        // Разрешение на кодирование/отправку (есть соединение)
      this.manualTx = false;           // Зажат ли PTT вручную
      this.txActive = false;           // Итоговый TX = manualTx

      // ==== TX аудио ====
      this.audioContextTx = null;
      this.stream = null;
      this.workletNode = null;
      this.sinkMute = null;
      this.micGainNode = null;
      this.isCapturing = false;
      this.sampleRateTx = C2_RATE;     // фактическая частота источника (после AudioContext)
      this.chunkSize = Math.round(this.sampleRateTx * TX_BLOCK_SEC);
      this.audioBuffer = [];

      // ==== Счётчики ====
      this.totalPcmBytes = 0;
      this.totalEncBytes = 0;
      this.totalDecBytes = 0;
      this.chunksEncoded = 0;

      // ==== RX аудио ====
      this.audioContextRx = null;
      this.rxGainNode = null;
      this.rxCompressorNode = null;
      this.rxSchedule = { bufferSec: 0.16, cursor: 0 };
      this._lastRxMode = null;            // для авто-сброса при смене режима

      // ==== RX VU плавный спад ====
      this.rxVuLevel = 0;
      this.rxVuPrevTs = 0;
      this.rxVuRaf = null;
      this.RX_VU_FALL_RATE = 2.2; // ед/сек
    }

    // ===== Публичные настройки =====
    setSendEnabled(v) { this.sendEnabled = !!v; this._updateTxState(false); }
    setManualTxActive(v) { this.manualTx = !!v; this._updateTxState(true); }
    setCodecModeProvider(fn) { if (typeof fn === "function") this.codecModeProvider = fn; }

    setRxGain(v) { if (this.rxGainNode) this.rxGainNode.gain.value = Number(v) || 1.0; }
    setRxBufferMs(ms) { const s = Math.max(40, Math.min(500, Number(ms)||160)) / 1000; this.rxSchedule.bufferSec = s; }
    setRxCompressorEnabled(on) {
      if (!this.rxCompressorNode || !this.audioContextRx) return;
      const now = this.audioContextRx.currentTime;
      if (on) {
        this.rxCompressorNode.threshold.setValueAtTime(-50, now);
        this.rxCompressorNode.knee.setValueAtTime(40, now);
        this.rxCompressorNode.ratio.setValueAtTime(12, now);
        this.rxCompressorNode.attack.setValueAtTime(0, now);
        this.rxCompressorNode.release.setValueAtTime(0.25, now);
      } else {
        this.rxCompressorNode.threshold.setValueAtTime(0, now);
        this.rxCompressorNode.knee.setValueAtTime(0, now);
        this.rxCompressorNode.ratio.setValueAtTime(1, now);
        this.rxCompressorNode.attack.setValueAtTime(0, now);
        this.rxCompressorNode.release.setValueAtTime(0, now);
      }
    }

    // Явный сброс RX пайплайна (можно вызывать при смене режима/шифрования)
    resetRxPipeline() {
      this._lastRxMode = null;
      this.rxSchedule.cursor = 0;
    }

    // ===== Захват (TX) =====
    async startCapture({ noiseSuppression, echoCancellation } = {}) {
      if (this.isCapturing) return;
      this.isCapturing = true;

      // сброс счётчиков
      this.totalPcmBytes = this.totalEncBytes = this.totalDecBytes = 0;
      this.chunksEncoded = 0;

      // Запрашиваем 8 кГц (браузер может дать 48 кГц — ниже мы всё равно ресемплим)
      this.audioContextTx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: C2_RATE });
      if (this.audioContextTx.state === "suspended") await this.audioContextTx.resume();

      await this.audioContextTx.audioWorklet.addModule("audio-processor.js"); // отдаёт сырые сэмплы с устройства. :contentReference[oaicite:4]{index=4}

      const constraints = {
        audio: {
          noiseSuppression: noiseSuppression ?? this.defaultNoiseSuppression,
          echoCancellation: echoCancellation ?? this.defaultEchoCancellation,
        },
        video: false
      };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);

      const src = this.audioContextTx.createMediaStreamSource(this.stream);
      this.micGainNode = this.audioContextTx.createGain();
      this.workletNode = new AudioWorkletNode(this.audioContextTx, "audio-processor");
      this.sinkMute = this.audioContextTx.createGain(); this.sinkMute.gain.value = 0.0;

      src.connect(this.micGainNode);
      this.micGainNode.connect(this.workletNode);
      this.workletNode.connect(this.sinkMute);
      this.sinkMute.connect(this.audioContextTx.destination);

      // Фактическая частота (иногда 48000) — обязательно ресемплим ниже.
      this.sampleRateTx = this.audioContextTx.sampleRate || C2_RATE;  // :contentReference[oaicite:5]{index=5}
      this.chunkSize     = Math.round(this.sampleRateTx * TX_BLOCK_SEC);

      this.workletNode.port.onmessage = (e) => this._onWorkletPCM(e.data);
    }

    async stopCapture({ flushTailIfSending = true } = {}) {
      if (!this.isCapturing) return;
      this.isCapturing = false;

      if (this.workletNode) { try { this.workletNode.port.onmessage = null; this.workletNode.disconnect(); } catch {} }
      if (this.micGainNode)  { try { this.micGainNode.disconnect(); } catch {} }
      if (this.sinkMute)     { try { this.sinkMute.disconnect(); } catch {} }
      if (this.stream)       { try { this.stream.getTracks().forEach(t => t.stop()); } catch {} }

      if (flushTailIfSending && this.sendEnabled && this.audioBuffer.length > 0 && this.manualTx) {
        await this._processChunk(new Float32Array(this.audioBuffer.splice(0)));
      }
      this.audioBuffer.length = 0;

      try { await this.audioContextTx?.close(); } catch {}
      this.audioContextTx = this.workletNode = this.sinkMute = this.micGainNode = null;

      // Сброс TX состояния
      this._updateTxState(true);
      this.onMicVu(0);
    }

    setMicGain(v) { if (this.micGainNode) this.micGainNode.gain.value = Number(v) || 1.0; }

    // ===== Приём =====
    appendRxEncoded(u8) {
      try {
        const mode = String(this.codecModeProvider() || "1300");

        // Авто-сброс, если режим сменился
        if (this._lastRxMode !== mode) {
          this._lastRxMode = mode;
          this.rxSchedule.cursor = 0;   // начнём плейаут заново
        }

        // Декодируем только этот кусок, без «всей истории»
        this._c2Decode(mode, u8).then((decoded) => {
          if (!decoded || decoded.byteLength === 0) return;

          const int16 = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength >> 1);
          const ctx = this._ensureRxCtx();
          this._scheduleChunkPlayback(ctx, int16);
          this.totalDecBytes += decoded.byteLength;
        }).catch((e) => console.error("RX decode:", e));
      } catch (e) {
        console.error("appendRxEncoded error:", e);
      }
    }

    // ===== Внутреннее: RX =====
    _ensureRxCtx() {
      if (!this.audioContextRx) {
        // Можно 8 кГц — браузер сам довыведет на устройство
        this.audioContextRx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: C2_RATE });
        this.rxGainNode = this.audioContextRx.createGain();
        this.rxCompressorNode = this.audioContextRx.createDynamicsCompressor();
        this.rxGainNode.connect(this.rxCompressorNode);
        this.rxCompressorNode.connect(this.audioContextRx.destination);
        this._startRxVuDecayLoop();
      }
      if (this.audioContextRx.state === "suspended") this.audioContextRx.resume().catch(() => {});
      return this.audioContextRx;
    }

    _scheduleChunkPlayback(ctx, int16) {
      if (!int16 || int16.length === 0) return;

      // RX VU пик + плавный спад
      this._pushRxVuPeak(int16);

      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32767;
      const buf = ctx.createBuffer(1, f32.length, C2_RATE);
      buf.copyToChannel(f32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.rxGainNode);

      const now = ctx.currentTime;
      const pad = Math.max(0.04, Math.min(0.5, this.rxSchedule.bufferSec));
      if (!this.rxSchedule.cursor || this.rxSchedule.cursor < now) {
        const startAt = now + pad;
        src.start(startAt);
        this.rxSchedule.cursor = startAt + buf.duration;
      } else {
        src.start(this.rxSchedule.cursor);
        this.rxSchedule.cursor += buf.duration;
      }
    }

    _startRxVuDecayLoop() {
      if (this.rxVuRaf) return;
      const tick = (ts) => {
        if (!this.rxVuPrevTs) this.rxVuPrevTs = ts;
        const dt = Math.min(0.1, Math.max(0, (ts - this.rxVuPrevTs) / 1000));
        this.rxVuPrevTs = ts;
        this.rxVuLevel = Math.max(0, this.rxVuLevel - this.RX_VU_FALL_RATE * dt);
        this.onRxVu(Math.max(0, Math.min(1, this.rxVuLevel)));
        this.rxVuRaf = requestAnimationFrame(tick);
      };
      this.rxVuRaf = requestAnimationFrame(tick);
    }

    _pushRxVuPeak(int16) {
      let peak = 0;
      for (let i = 0; i < int16.length; i++) {
        const a = Math.abs(int16[i]);
        if (a > peak) peak = a;
      }
      this.rxVuLevel = Math.max(this.rxVuLevel, Math.min(1, peak / 32767));
    }

    // ===== Внутреннее: TX =====
    _onWorkletPCM(pcm) {
      if (!pcm || pcm.length === 0) return;

      // Mic VU всегда (даже без подключения)
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        const a = Math.abs(pcm[i]);
        if (a > peak) peak = a;
      }
      this.onMicVu(Math.min(1, peak));

      // Кодирование/отправка — только когда есть соединение и зажат PTT
      if (!this.sendEnabled || !this.manualTx) return;

      this.audioBuffer.push(...pcm);
      while (this.audioBuffer.length >= this.chunkSize) {
        const chunk = this.audioBuffer.splice(0, this.chunkSize);
        this._processChunk(new Float32Array(chunk));
      }
    }

    _updateTxState(notify = true) {
      const prev = this.txActive;
      this.txActive = !!this.manualTx;
      if (notify && prev !== this.txActive) this.onTxStateChange(this.txActive);
    }

    async _processChunk(float32Chunk) {
      // 1) Приводим частоту к 8 кГц (если источник ≠ 8 кГц)
      let f32 = float32Chunk;
      if (this.sampleRateTx !== C2_RATE) {
        f32 = AudioEngine._resampleLinear(f32, this.sampleRateTx, C2_RATE);
      }

      // 2) Лёгкая подготовка сигнала: DC-block/high-pass (+ опционально pre-emphasis)
      f32 = AudioEngine._dcBlockHighPass(f32, C2_RATE, HP_FC_HZ);
      if (PREEMPH_A > 0) f32 = AudioEngine._preEmphasis(f32, PREEMPH_A);

      // 3) Мягкий лимитер во float (чтобы не клиппить кодек)
      for (let i=0;i<f32.length;i++){
        let s = Math.max(-1, Math.min(1, f32[i]));
        const k = 2.0; // степень «мягкости»
        s = (1 + k) * s / (1 + k * Math.abs(s));
        f32[i] = s;
      }

      // 4) В int16 и в энкодер
      const int16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) int16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
      this.totalPcmBytes += int16.byteLength;

      const mode = String(this.codecModeProvider() || "1300");
      const encoded = await this._c2Encode(mode, int16.buffer);
      const u8 = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
      this.totalEncBytes += u8.byteLength;
      this.chunksEncoded++;

      try { this.onEncodedFrame(u8); } catch (e) { console.error("onEncodedFrame error:", e); }
    }

    // ===== Codec2 wrappers (WASM) =====
    _c2Decode(mode, data) {
      return new Promise((resolve) => {
        const mod = {
          arguments: [mode, "in.bit", "out.raw"],
          preRun: () => mod.FS.writeFile("in.bit", new Uint8Array(data)),
          postRun: () => resolve(mod.FS.readFile("out.raw", { encoding: "binary" })),
        };
        createC2Dec(mod);
      });
    }

    _c2Encode(mode, data) {
      return new Promise((resolve) => {
        const mod = {
          arguments: [mode, "in.raw", "out.bit"],
          preRun: () => mod.FS.writeFile("in.raw", new Uint8Array(data)),
          postRun: () => resolve(mod.FS.readFile("out.bit", { encoding: "binary" })),
        };
        createC2Enc(mod);
      });
    }

    // ===== Утилиты =====
    static _u8Concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }

    // Линейный ресемплер (для речи хватает)
    static _resampleLinear(f32, fromRate, toRate){
      if (fromRate === toRate) return f32;
      const ratio = toRate / fromRate;
      const outLen = Math.max(1, Math.floor(f32.length * ratio));
      const out = new Float32Array(outLen);
      let pos = 0;
      const step = 1 / ratio;
      for (let i = 0; i < outLen; i++) {
        const idx = pos | 0;
        const frac = pos - idx;
        const s0 = f32[idx] || 0;
        const s1 = f32[idx + 1] || s0;
        out[i] = s0 + (s1 - s0) * frac;
        pos += step;
      }
      return out;
    }

    // DC-block / простой high-pass 1-го порядка
    static _dcBlockHighPass(f32, rate, fc=HP_FC_HZ){
      const out = new Float32Array(f32.length);
      const dt = 1 / rate;
      const RC = 1 / (2 * Math.PI * Math.max(10, fc));
      const alpha = RC / (RC + dt); // y[n] = alpha*(y[n-1] + x[n] - x[n-1])
      let y1 = 0, x1 = 0;
      for (let i=0;i<f32.length;i++){
        const x = f32[i] || 0;
        const y = alpha * (y1 + x - x1);
        out[i] = y;
        y1 = y; x1 = x;
      }
      return out;
    }

    // Pre-emphasis: y[n] = x[n] − a·x[n−1]
    static _preEmphasis(f32, a = 0.97){
      const out = new Float32Array(f32.length);
      let prev = 0;
      for (let i=0;i<f32.length;i++){
        const x = f32[i] || 0;
        out[i] = x - a * prev;
        prev = x;
      }
      return out;
    }

    // ===== Доступ к счётчикам =====
    getCounters() {
      return {
        totalPcmBytes: this.totalPcmBytes,
        totalEncBytes: this.totalEncBytes,
        totalDecBytes: this.totalDecBytes,
        chunksEncoded: this.chunksEncoded,
        txActive: this.txActive,
      };
    }
  }

  global.AudioEngine = AudioEngine;
})(window);
