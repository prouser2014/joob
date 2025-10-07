// www/serial.js
// UART только с двумя бэкендами:
//  • Capacitor-плагин UsbSerial (com.viewtrak.plugins.usbserial) — ТЕКСТОВЫЙ транспорт
//  • (опция) Web Serial в десктопном браузере — БИНАРНЫЙ транспорт
//
// Если хочешь полностью отключить Web Serial — поставь ENABLE_WEB_SERIAL = false.

(() => {
  const ENABLE_WEB_SERIAL = true; // ← выключи, если нужен только плагин
  const log   = (...a) => console.log("[UART]", ...a);
  const delay = (ms)  => new Promise(r => setTimeout(r, ms));

  // --- Платформа / плагин
  const isCapacitor = !!window.Capacitor;
  const platform = isCapacitor && typeof window.Capacitor.getPlatform === "function"
    ? window.Capacitor.getPlatform()
    : "web";
  const isAndroidNative = platform === "android";

  const CapSerial =
    (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.UsbSerial) ||
    window.UsbSerial || null;

  // --- Утилиты
  const toU8 = (data) => {
    if (!data) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return new Uint8Array(data);
    if (typeof data === "string") return new TextEncoder().encode(data);
    return new Uint8Array(0);
  };

  function pickMethod(obj, names) {
    if (!obj) return null;
    for (const n of names) if (typeof obj[n] === "function") return obj[n].bind(obj);
    const keys = new Set();
    try { Object.getOwnPropertyNames(obj).forEach(k=>keys.add(k)); } catch(_){}
    try { Object.keys(obj).forEach(k=>keys.add(k)); } catch(_){}
    const lower = {};
    for (const k of keys) lower[String(k).toLowerCase()] = k;
    for (const n of names) {
      const key = lower[String(n).toLowerCase()];
      if (key && typeof obj[key] === "function") return obj[key].bind(obj);
    }
    return null;
  }

  class UartPort {
    constructor() {
      this._cap = CapSerial;
      this._capApi = null;
      this._capSubs = [];
      this._backend = null; // 'cap' | 'web'
      this._onStatus = null;
      this._onData = null;
      this._connected = false;

      // Web Serial
      this.port = null;
      this.reader = null;
    }

    onStatus(fn){ this._onStatus = fn; }
    onData(fn){ this._onData = fn; }

    getBackend(){ return this._backend; } // ← добавил, чтобы UI знал какой транспорт активен

    async enumerateDevices(){
      if (this._cap && isAndroidNative) {
        const connectedDevices = pickMethod(this._cap, ["connectedDevices"]);
        if (!connectedDevices) return [];
        try {
          const r = await connectedDevices();
          return Array.isArray(r) ? r : (r && Array.isArray(r.devices) ? r.devices : []);
        } catch (_) { return []; }
      }
      if (ENABLE_WEB_SERIAL && navigator.serial?.getPorts) {
        try { return await navigator.serial.getPorts(); } catch(_) {}
      }
      return [];
    }

    async requestPermission(){
      if (this._cap && isAndroidNative) return true; // у плагина запрос прав внутри openSerial
      if (ENABLE_WEB_SERIAL && navigator.serial?.requestPort) {
        try { this.port = await navigator.serial.requestPort(); return true; }
        catch (e) { throw new Error(e?.message || "Порт не выбран"); }
      }
      throw new Error("Нет доступного бэкенда (UsbSerial/Web Serial).");
    }

    async connect(baud = 115200, preferDevice = null){
      if (this._connected) return;

      if (this._cap && isAndroidNative) {
        await this._connectCapSerial(baud, preferDevice);
        this._backend = "cap";
      } else if (ENABLE_WEB_SERIAL && navigator.serial) {
        await this._connectWebSerial(baud);
        this._backend = "web";
      } else {
        throw new Error("Доступный бэкенд не найден. На Android нужна нативная сборка с плагином, в браузере — Web Serial на HTTPS.");
      }

      this._connected = true;
      this._onStatus?.(`Подключено (${this._backend})`);
    }

    async disconnect(){
      try {
        if (this._backend === "cap") await this._disconnectCapSerial();
        if (this._backend === "web") await this._disconnectWebSerial();
      } finally {
        this._backend = null;
        this._connected = false;
        this._onStatus?.("Отключено");
      }
    }

    async write(data){
      const u8 = toU8(data);
      if (u8.length === 0) throw new Error("write: пустые данные");
      if (this._backend === "cap") return this._writeCapSerial(u8);
      if (this._backend === "web") return this._writeWebSerial(u8);
      throw new Error("Нет активного соединения");
    }

    // ====== UsbSerial (строчный транспорт) ======
    async _connectCapSerial(baud, preferDevice){
      const api = {
        connectedDevices: pickMethod(this._cap, ["connectedDevices"]),
        openSerial:       pickMethod(this._cap, ["openSerial","open","openConnection","connect","openPort"]),
        closeSerial:      pickMethod(this._cap, ["closeSerial","close","closeConnection","disconnect"]),
        writeSerial:      pickMethod(this._cap, ["writeSerial","write","send","writeBytes"]),
        addListener:      pickMethod(this._cap, ["addListener","on"]),
        removeAll:        pickMethod(this._cap, ["removeAllListeners","off"]),
      };
      if (!api.connectedDevices || !api.openSerial) {
        throw new Error("UsbSerial найден, но отсутствует API (connectedDevices/openSerial). Проверь версию плагина.");
      }

      let devices = [];
      for (let i=0;i<3 && devices.length===0;i++){
        try {
          const r = await api.connectedDevices();
          devices = Array.isArray(r) ? r : (r && Array.isArray(r.devices) ? r.devices : []);
        } catch(_) {}
        if (devices.length===0) await delay(250);
      }

      let picked = preferDevice || (devices[0] || null);
      if (!picked) {
        let attached = null;
        try {
          const sub = await api.addListener?.("attached", (d)=>{ attached = d; });
          await delay(1200);
          if (attached) picked = attached;
          try { await sub?.remove?.(); } catch(_) {}
        } catch(_) {}
      }
      if (!picked) throw new Error("USB-устройство не найдено плагином UsbSerial. Проверь OTG/питание/разрешение.");

      const dev = picked.device || picked;
      const deviceId = dev.deviceId ?? dev.did ?? dev.id;
      const portNum  = picked.port ?? 0;

      await api.openSerial({
        deviceId,
        portNum,
        baudRate: baud,
        dataBits: 8,
        stopBits: 1,
        parity: 0,
        dtr: true,
        rts: true,
      });

      if (api.addListener) {
        const subData = await api.addListener("data", (msg) => {
          const s = typeof msg?.data === "string" ? msg.data : "";
          // НИЧЕГО не добавляем — main.js сам разделит по \r?\n
          this._onData?.(new TextEncoder().encode(s));
        });
        const subErr  = await api.addListener("error", (e)=> this._onStatus?.(`USB ошибка: ${e?.error||e}`));
        const subAtt  = await api.addListener("attached", ()=> this._onStatus?.("USB подключено"));
        const subDet  = await api.addListener("detached", ()=> this._onStatus?.("USB отключено"));
        this._capSubs.push(subData, subErr, subAtt, subDet);
      }

      this._capApi = api;
    }

    async _disconnectCapSerial(){
      try { for (const s of this._capSubs) { try { await s?.remove?.(); } catch(_) {} } } finally { this._capSubs = []; }
      try { await this._capApi?.closeSerial?.(); } catch(_) {}
      try { await this._capApi?.removeAll?.(); } catch(_) {}
      this._capApi = null;
    }

    async _writeCapSerial(u8){
      // Плагин принимает только строки — сюда должны попадать уже текстовые данные (например, "C2:...\\n")
      const s = new TextDecoder().decode(u8);
      await this._capApi.writeSerial({ data: s });
    }

    // ====== Web Serial (бинарный транспорт) ======
    async _connectWebSerial(baud){
      if (!ENABLE_WEB_SERIAL) throw new Error("Web Serial отключён.");
      if (!navigator.serial) throw new Error("Web Serial недоступен в этом окружении.");

      let port = this.port;
      if (!port && navigator.serial.getPorts) {
        try {
          const ports = await navigator.serial.getPorts();
          if (ports && ports.length) port = ports[0];
        } catch(_) {}
      }
      if (!port) {
        try { port = await navigator.serial.requestPort(); }
        catch { throw new Error("Порт не выбран"); }
      }

      this.port = port;
      await port.open({ baudRate: baud });

      this.reader = port.readable?.getReader?.();
      (async () => {
        while (this.reader) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this._onData?.(value);
        }
      })().catch(()=>{});

      this._onStatus?.("Подключено (web)");
    }

    async _disconnectWebSerial(){
      try { await this.reader?.cancel(); } catch(_) {}
      try { await this.port?.close(); } catch(_) {}
      this.reader = null; this.port = null;
    }

    async _writeWebSerial(u8){
      if (!this.port?.writable) throw new Error("Порт не открыт");
      const w = this.port.writable.getWriter();
      await w.write(u8);
      w.releaseLock();
    }
  }

  // Экспорт
  window.UART = window.UART || {};
  window.UART.UartPort = UartPort;
  window.UART.Uart = UartPort;
  window.__SERIAL_JS_OK__ = true;
  log("serial.js: готов (UsbSerial=строки, WebSerial=бинарь)");
})();
