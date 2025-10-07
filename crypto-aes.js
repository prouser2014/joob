// crypto-aes.js — режим без рукопожатия.
// Формат шифрованного кадра (бинарь на «проволоке»):
//   [0xE2][IV:12][CIPHERTEXT || TAG(12)]
// В текстовом UsbSerial это же отправляется как строка:
//   "E2:" + base64(весь бинарный кадр) + "\n"
//
// Ключ задаётся напрямую (hex), длина 128/256 бит. Для каждого пакета генерируется
// случайный 96-битный IV (nonce). Приёмник берёт IV из кадра и сразу расшифровывает.
// Для базовой защиты от повторов держим LRU-окно последних IV.
//
// Публичный API (как и раньше, но без beginHandshake):
//   const enc = new CryptoAesController({ getAad, onStatus });
//   enc.setEnabled(true|false);
//   enc.setKeyBits(128|256);
//   enc.setKeyHex(hexStr);
//   enc.attachTransport({ backend: 'cap'|'webserial', write: async(data)=>{} });
//   const r1 = await enc.onTextLine(line);   // {handled, plaintext?}
//   const r2 = await enc.onBinary(u8);       // {handled, plaintext?}
//   const e2 = await enc.wrapOutgoing(plainU8); // Uint8Array [0xE2|IV|CT||TAG]
//   enc.isReady(); enc.getStatusText(); enc.getBits();

(function (global) {
  const te = new TextEncoder();

  // ---------- утилиты ----------
  function u8(...args){ return new Uint8Array(...args); }
  function u8concat(...arrs){
    let len = 0; for (const a of arrs) len += a.length;
    const out = new Uint8Array(len);
    let off = 0; for (const a of arrs){ out.set(a, off); off += a.length; }
    return out;
  }
  function randBytes(n){ const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
  function b64FromU8(u8a){
    let s=""; for (let i=0;i<u8a.length;i++) s += String.fromCharCode(u8a[i]);
    return btoa(s);
  }
  function u8FromB64(b64){
    const bin = atob(b64.trim());
    const u8a = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) u8a[i] = bin.charCodeAt(i) & 0xff;
    return u8a;
  }
  function cleanHex(str){ return (str||"").toLowerCase().replace(/[^0-9a-f]/g,""); }

  // ---------- шифратор без рукопожатия ----------
  class AesNoHs {
    constructor(rawKeyBytes, keyBits){
      this.keyBits = (keyBits === 128) ? 128 : 256;
      this._keyPromise = crypto.subtle.importKey(
        "raw", rawKeyBytes, { name: "AES-GCM", length: this.keyBits }, false, ["encrypt","decrypt"]
      );
    }
    async encryptFrame(plainU8, aadU8){
      const key = await this._keyPromise;
      const iv = randBytes(12); // уникальный IV на пакет
      const ctTag = new Uint8Array(await crypto.subtle.encrypt(
        { name:"AES-GCM", iv, additionalData: aadU8 || new Uint8Array(0), tagLength: 96 },
        key,
        plainU8
      ));
      const head = new Uint8Array(1+12);
      head[0] = 0xE2;
      head.set(iv, 1);
      return u8concat(head, ctTag);
    }
    async decryptFrame(frameU8, aadU8){
      if (!frameU8 || frameU8.length < 1+12+12) throw new Error("frame too short");
      if (frameU8[0] !== 0xE2) throw new Error("bad magic");
      const iv = frameU8.subarray(1, 13);
      const ct = frameU8.subarray(13);
      const key = await this._keyPromise;
      const pt = new Uint8Array(await crypto.subtle.decrypt(
        { name:"AES-GCM", iv, additionalData: aadU8 || new Uint8Array(0), tagLength: 96 },
        key,
        ct
      ));
      return { iv, plaintext: pt };
    }
  }

  // ---------- высокоуровневый контроллер ----------
  class CryptoAesController {
    /**
     * @param {{getAad?:()=>Uint8Array, onStatus?:(s:string)=>void}} cfg
     */
    constructor(cfg = {}){
      this.enabled = true;
      this.keyBits = 256;     // 256 | 128
      this._pskBytes = null;  // Uint8Array
      this._aes = null;       // AesNoHs

      this._backend = null;   // 'cap' | 'webserial'
      this._write = null;     // async (Uint8Array|string) => Promise<void>

      this._getAad = typeof cfg.getAad === 'function' ? cfg.getAad : (()=>new Uint8Array(0));
      this._onStatus = typeof cfg.onStatus === 'function' ? cfg.onStatus : (()=>{});

      // LRU окно последних IV (для anti-replay на приёме)
      this._seenIV = new Set(); // ключ — base64(IV)
      this._seenQueue = [];     // порядок добавления
      this._seenLimit = 256;    // размер окна
      this._updateStatus();
    }

    // --- базовые настройки ---
    setEnabled(v){
      this.enabled = !!v;
      this._updateStatus();
    }
    isEnabled(){ return !!this.enabled; }

    setKeyBits(bits){
      const nb = (bits === 128) ? 128 : 256;
      if (this.keyBits !== nb){
        this.keyBits = nb;
        // смена длины ключа инвалидирует текущий ключ
        if (this._pskBytes) this._ensureAes();
      }
      this._updateStatus();
    }
    getBits(){ return this.keyBits; }

    /** Установка ключа в hex; валидирует длину под keyBits */
    setKeyHex(hexStr){
      const clean = cleanHex(hexStr);
      const needChars = (this.keyBits/8)*2;
      if (clean.length !== needChars){
        this._onStatus(`ошибка ключа: нужно ${needChars} hex-символов для AES-${this.keyBits}`);
        return false;
      }
      const bytes = this.keyBits/8;
      const out = new Uint8Array(bytes);
      for(let i=0;i<bytes;i++) out[i] = parseInt(clean.substr(i*2,2),16);
      this._pskBytes = out;
      this._ensureAes();
      this._onStatus("ключ сохранён");
      return true;
    }

    _ensureAes(){
      this._aes = this._pskBytes ? new AesNoHs(this._pskBytes, this.keyBits) : null;
    }

    // --- транспорт (оставлено для совместимости; не обязателен в этом режиме) ---
    attachTransport({ backend, write }){
      this._backend = backend;   // 'cap' | 'webserial'
      this._write = write;       // async
    }

    // --- приём с транспорта ---
    async onTextLine(line){
      if (typeof line !== "string") return { handled:false };

      // E2:<base64> (шифрованный кадр)
      if (line.startsWith("E2:")){
        // мы берём на себя обработку E2 всегда (даже если шифрование выключено),
        // чтобы legacy-путь C2 не поймал эти строки.
        if (!(this.enabled && this._aes)) return { handled:true };
        try{
          const frame = u8FromB64(line.slice(3).trim());
          const aad = this._getAad();
          const { iv, plaintext } = await this._aes.decryptFrame(frame, aad);
          if (!this._checkReplay(iv)) return { handled:true }; // отбрасываем повтор
          return { handled:true, plaintext };
        }catch(_){
          // Ошибка тега/ключа — молча игнорируем кадр
          return { handled:true };
        }
      }

      return { handled:false };
    }

    async onBinary(u8data){
      const u8a = (u8data instanceof Uint8Array) ? u8data : new Uint8Array(u8data||0);
      if (u8a.length === 0) return { handled:false };

      if (u8a[0]===0xE2){
        if (!(this.enabled && this._aes)) return { handled:true };
        try{
          const aad = this._getAad();
          const { iv, plaintext } = await this._aes.decryptFrame(u8a, aad);
          if (!this._checkReplay(iv)) return { handled:true };
          return { handled:true, plaintext };
        }catch(_){
          return { handled:true };
        }
      }

      return { handled:false };
    }

    // --- исходящие кадры ---
    async wrapOutgoing(plainU8){
      if (!(this.enabled && this._aes)) throw new Error("encryption not ready");
      const aad = this._getAad();
      return this._aes.encryptFrame(plainU8, aad); // Uint8Array [0xE2|IV|CT||TAG]
    }

    // --- статус ---
    isReady(){ return !!(this.enabled && this._aes); }
    getStatusText(){ return this.enabled ? (this._aes ? `AES-${this.keyBits}-GCM` : "нет ключа") : "выкл"; }

    _updateStatus(){
      this._onStatus(this.getStatusText());
    }

    // --- anti-replay: LRU набор последних IV ---
    _checkReplay(ivU8){
      try{
        const tag = b64FromU8(ivU8);
        if (this._seenIV.has(tag)) return false; // повтор — отбросить
        this._seenIV.add(tag);
        this._seenQueue.push(tag);
        if (this._seenQueue.length > this._seenLimit){
          const old = this._seenQueue.shift();
          this._seenIV.delete(old);
        }
      }catch(_){}
      return true;
    }
  }

  // Экспорт
  global.CryptoAesController = CryptoAesController;
})(window);
