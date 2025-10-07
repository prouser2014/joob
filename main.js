// === Конфиг UART ===
const DEFAULT_BAUD   = 115200;
const UART_FRAMED    = false;     // для Web Serial (бинарь). Для UsbSerial не используется
const SEND_DELAY_MS  = 3;

// === Утилиты ===
const te = new TextEncoder();
const td = new TextDecoder();

const b64FromU8 = (u8) => {
  let s = ""; for (let i=0;i<u8.length;i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
};
const u8FromB64 = (b64) => {
  const bin = atob(b64.trim());
  const u8 = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i) & 0xff;
  return u8;
};
const fmtBytes = (n)=>{const u=["байт","КБ","МБ"];let i=0,v=n||0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return (i===0?v:v.toFixed(2))+" "+u[i];};
const cleanHex = (str)=> (str||"").toLowerCase().replace(/[^0-9a-f]/g,"");
function randomHex(bytes){
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (let i=0;i<b.length;i++) s += b[i].toString(16).padStart(2,"0");
  return s;
}

// === Тосты ===
function showToast(msg, type="ok", ttl=2200){
  const wrap = document.getElementById("toast-wrap");
  if (!wrap) return;
  const div = document.createElement("div");
  div.className = `toast-item ${type}`;
  div.textContent = msg;
  wrap.appendChild(div);
  requestAnimationFrame(()=> div.classList.add("show"));
  const close = ()=> {
    div.classList.remove("show");
    setTimeout(()=> { if (div.parentNode) wrap.removeChild(div); }, 220);
  };
  const t1 = setTimeout(close, ttl);
  div.addEventListener("click", ()=> { clearTimeout(t1); close(); });
}

// === Журнал (одно поле, с меткой времени ЧЧ:ММ) ===
function hhmm(){
  const d = new Date();
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}
function logLine(text){
  const ta = els.logAll;
  if (!ta) return;
  ta.value += `${hhmm()} ${text.endsWith("\n") ? text : text + "\n"}`;
  ta.scrollTop = ta.scrollHeight;
}

// === DOM-элементы ===
const els = {};
function collectEls(){
  // PTT/аудио
  els.pttCircle             = document.getElementById("state-circle");
  els.vuMic                 = document.getElementById("vu-mic");
  els.vuRx                  = document.getElementById("vu-rx");
  els.codecSelect           = document.getElementById("codec");
  els.rxBufferMsInput       = document.getElementById("rxBufferMs");
  els.micGainSlider         = document.getElementById("micGain");
  els.rxGainSlider          = document.getElementById("rxGain");
  els.noiseSuppressionCheck = document.getElementById("noiseSuppression");
  els.echoCancellationCheck = document.getElementById("echoCancellation");
  els.rxCompressorCheck     = document.getElementById("rxCompressor");

  // UART/журнал
  els.btnConnect   = document.getElementById("btn-connect");
  els.uartStatus   = document.getElementById("uart-status");
  els.logAll       = document.getElementById("log-all");   // единое поле

  // Шифрование (UI)
  els.encEnable     = document.getElementById("encEnable");
  els.encKeyBits    = document.getElementById("encKeyBits");
  els.encStatus     = document.getElementById("encStatus"); // элемента нет — ок
  els.encSingleHex  = document.getElementById("encSingleHex");
  els.encApply      = document.getElementById("encApply");
  els.encGen        = document.getElementById("encGen");
  els.encCopy       = document.getElementById("encCopy");
}

// === Состояния ===
let uart = null, uartConnected = false, rxCounter = 0;
let writesDone = 0;
let capLineBuf = ""; // для UsbSerial строк

// Аудиодвижок
let engine = null;

// Криптоконтроллер (без рукопожатия: IV в каждом пакете)
let encCtrl = null;

// Хранилище одного ключа (hex) в localStorage
const LS_SINGLE_HEX = "enc.single.hex.v1";

// Статусы
function setUartStatus(s){ if (els.uartStatus) els.uartStatus.textContent = s; }
function setEncStatus(s){ if (els.encStatus) els.encStatus.textContent = s; } // если элемента нет — молчим

// === RX VU визуализация ===
function setMicVu(level){ const el=els.vuMic; if (el) el.style.width = `${Math.round(level*100)}%`; }
function setRxVu(level){  const el=els.vuRx;  if (el) el.style.width  = `${Math.round(level*100)}%`; }

// === Инициализация ===
async function initApp(){
  // 1) Сбор DOM и моментально привязываем кнопку
  collectEls();

  if (els.btnConnect){
    els.btnConnect.addEventListener("click", uartConnectToggle, { passive:true });
  }

  // Аккуратно настраиваем PTT (если есть в разметке)
  if (els.pttCircle){
    els.pttCircle.setAttribute("role","button");
    els.pttCircle.setAttribute("tabindex","0");
    els.pttCircle.style.touchAction = "none";
    els.pttCircle.style.userSelect  = "none";
    bindPttHandlers();
  }

  // Восстанавливаем ключ из localStorage
  try{
    const savedHex = localStorage.getItem(LS_SINGLE_HEX);
    if (savedHex && els.encSingleHex) els.encSingleHex.value = savedHex;
  }catch(_){}

  // Аудиодвижок
  engine = new AudioEngine({
    onMicVu: setMicVu,
    onRxVu : setRxVu,
    onTxStateChange: (on)=>{
      if(!els.pttCircle) return;
      els.pttCircle.classList.toggle("red",  !!on);
      els.pttCircle.classList.toggle("green",!on);
    },
    onEncodedFrame: (u8)=> sendEncodedFrame(u8),
    codecModeProvider: ()=> {
      const modeSel = (els.codecSelect?.value || "c2chunk_1300");
      return String(modeSel).replace("c2chunk_", "");
    },
    noiseSuppression: !!(els.noiseSuppressionCheck?.checked ?? true),
    echoCancellation: !!(els.echoCancellationCheck?.checked ?? true),
  });

  // Криптоконтроллер (без рукопожатия)
  encCtrl = new CryptoAesController({
    getAad: ()=> new Uint8Array([1, ...te.encode((els.codecSelect?.value||"").slice(-4))]),
    onStatus: setEncStatus,
  });
  encCtrl.setEnabled(true);
  if (els.encKeyBits) encCtrl.setKeyBits(parseInt(els.encKeyBits.value,10) || 256);

  // Аудио-настройки
  els.micGainSlider?.addEventListener("input", () => engine.setMicGain(els.micGainSlider.value));
  els.rxGainSlider ?.addEventListener("input", () => engine.setRxGain(els.rxGainSlider.value));
  els.rxCompressorCheck?.addEventListener("change", () => engine.setRxCompressorEnabled(els.rxCompressorCheck.checked));
  if (els.rxBufferMsInput) {
    els.rxBufferMsInput.addEventListener("input", () => engine.setRxBufferMs(els.rxBufferMsInput.value));
    engine.setRxBufferMs(els.rxBufferMsInput.value);
  }

  // UI шифрования
  els.encEnable?.addEventListener("change", ()=>{
    const on = els.encEnable.checked;
    encCtrl.setEnabled(on);
    showToast(on ? "Шифрование включено" : "Шифрование выключено", "ok");
  });
  els.encKeyBits?.addEventListener("change", ()=>{
    encCtrl.setKeyBits(parseInt(els.encKeyBits.value,10));
    updateHexInputStyle();
  });
  els.encApply?.addEventListener("click", applyKeyNoHandshake);
  els.encSingleHex?.addEventListener("keydown", (e)=>{
    if (e.key === "Enter") { e.preventDefault(); applyKeyNoHandshake(); }
  });
  els.encSingleHex?.addEventListener("input", ()=>{
    try{ localStorage.setItem(LS_SINGLE_HEX, els.encSingleHex.value || ""); }catch(_){}
    updateHexInputStyle();
  });
  els.encGen?.addEventListener("click", ()=>{
    const bits  = parseInt(els.encKeyBits.value,10);
    const bytes = bits/8;
    const hex = randomHex(bytes);
    els.encSingleHex.value = hex;
    try{ localStorage.setItem(LS_SINGLE_HEX, hex); }catch(_){}
    updateHexInputStyle();
    showToast("Случайный ключ сгенерирован. Нажмите «Записать ключ», чтобы применить.", "ok", 2600);
  });
  els.encCopy?.addEventListener("click", async ()=>{
    const txt = (els.encSingleHex.value || "").trim();
    if (!txt) { showToast("Поле ключа пустое — нечего копировать.", "err"); return; }
    const ok = await copyToClipboardSafe(txt);
    showToast(ok ? "Ключ успешно скопирован в буфер обмена" : "Не удалось скопировать — скопируйте вручную", ok ? "ok" : "err");
  });

  updateHexInputStyle();
}

function updateHexInputStyle(){
  if (!els.encKeyBits || !els.encSingleHex) return;
  const bits = parseInt(els.encKeyBits.value,10);
  const needChars = (bits/8)*2;
  const ok = cleanHex(els.encSingleHex.value).length === needChars;
  els.encSingleHex.style.borderColor = ok ? "var(--btn-border)" : "#b0362c";
  els.encSingleHex.title = ok ? "" : `Нужно ровно ${needChars} hex-символов для AES-${bits}`;
}

// Нажатие «Записать ключ» (без рукопожатия)
async function applyKeyNoHandshake(){
  try{ localStorage.setItem(LS_SINGLE_HEX, els.encSingleHex.value || ""); }catch(_){}
  const ok = encCtrl.setKeyHex(els.encSingleHex.value);
  updateHexInputStyle();
  if (!ok) { showToast("Ошибка: длина ключа не соответствует выбранному AES", "err"); return; }
  showToast("Ключ успешно записан", "ok");
}

// === Копирование в буфер обмена (безопасный фоллбек) ===
async function copyToClipboardSafe(text){
  try{
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  }catch(_){}
  try{
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }catch(_){
    return false;
  }
}

// === PTT ===
let pttActive = false, suppressMouseUntil = 0;
function bindPttHandlers(){
  const btn = els.pttCircle; if (!btn) return;

  const start = async (e)=>{
    const now = Date.now();
    if (e && e.type.startsWith("mouse") && now < suppressMouseUntil) return;
    if (pttActive) return;
    if (e) {
      try { e.preventDefault(); e.stopPropagation(); } catch(_) {}
      if (e.type === "pointerdown" && typeof btn.setPointerCapture === "function") { try { btn.setPointerCapture(e.pointerId); } catch(_) {} }
      if (e.type === "touchstart") suppressMouseUntil = now + 1000;
    }
    await engine.startCapture({
      noiseSuppression: !!(els.noiseSuppressionCheck?.checked ?? true),
      echoCancellation: !!(els.echoCancellationCheck?.checked ?? true),
    });
    engine.setManualTxActive(true);
    pttActive = true;
  };
  const stop = async (e)=>{
    const now = Date.now();
    if (e && e.type.startsWith("mouse") && now < suppressMouseUntil) return;
    if (!pttActive) return;
    if (e) {
      try { e.preventDefault(); e.stopPropagation(); } catch(_) {}
      if (e.type === "pointerup" && typeof btn.releasePointerCapture === "function") { try { btn.releasePointerCapture(e.pointerId); } catch(_) {} }
    }
    engine.setManualTxActive(false);
    pttActive = false;
    await engine.stopCapture({ flushTailIfSending: uartConnected });
  };

  btn.addEventListener("pointerdown", start, { passive:false });
  btn.addEventListener("pointerup",    stop,  { passive:false });
  btn.addEventListener("pointercancel",stop,  { passive:false });
  btn.addEventListener("lostpointercapture", stop);
  btn.addEventListener("touchstart",   start, { passive:false });
  btn.addEventListener("touchend",     stop,  { passive:false });
  btn.addEventListener("touchcancel",  stop,  { passive:false });
  btn.addEventListener("mousedown", start);
  window.addEventListener("mouseup", stop);
  btn.addEventListener("keydown", (e)=>{ if(e.code==="Space"||e.code==="Enter") start(e); });
  btn.addEventListener("keyup",   (e)=>{ if(e.code==="Space"||e.code==="Enter") stop(e);  });
}

// === UART инфраструктура ===
async function waitForUart(timeoutMs = 4000){
  const start = performance.now();
  while (!(window.UART && (window.UART.UartPort || window.UART.Uart))) {
    await new Promise(r=>setTimeout(r,50));
    if (performance.now() - start > timeoutMs) {
      throw new Error('UART слой не найден (serial.js). Убедись, что <script src="serial.js"></script> подключён ДО main.js.');
    }
  }
}
function backend(){ return uart?.getBackend?.() || "unknown"; }
function framePacketBinary(u8){
  if(!UART_FRAMED) return u8;
  const len = u8.byteLength, out = new Uint8Array(2+len);
  out[0]=len&0xFF; out[1]=(len>>>8)&0xFF; out.set(u8,2);
  return out;
}

// --- Нормализация известных текстов ошибок ---
function normalizeUartErrorMessage(msg){
  const s = String(msg || "");
  if (s.includes("USB-устройство не найден плагином")) {
    return "USB-устройство не подключено, проверьте USB-кабель";
  }
  return s;
}

// === Кнопка «Подключить устройство» ===
async function uartConnectToggle(){
  try { await waitForUart(3000); } catch (e) { setUartStatus(e.message); logLine(`Ошибка: ${e.message}`); return; }

  const U = window.UART.UartPort || window.UART.Uart;
  if(!U){ setUartStatus("UART слой не найден (serial.js)"); logLine("Ошибка: UART не найден"); return; }

  if(!uartConnected){
    try{
      uart = new U();
      uart.onStatus((s)=> setUartStatus(String(s)));
      uart.onData((ab)=> handleUartData(ab));

      setUartStatus("Запрашиваю доступ к USB/Serial…");
      try {
        await uart.requestPermission();
      } catch (ePerm) {
        const raw = ePerm?.message || ePerm;
        const friendly = normalizeUartErrorMessage(raw);
        setUartStatus(`Разрешение не выдано: ${friendly}`);
        logLine(`Ошибка: ${friendly}`);
        return;
      }

      const baudEl = document.getElementById("baud");
      const baud = baudEl ? parseInt(baudEl.value, 10) || DEFAULT_BAUD : DEFAULT_BAUD;

      setUartStatus("Подключаюсь к устройству…");
      await uart.connect(baud, null);

      uartConnected = true;
      engine.setSendEnabled(true);

      if (els.btnConnect){
        els.btnConnect.textContent = "Отключить устройство";
        els.btnConnect.classList.remove("danger");
        els.btnConnect.classList.add("success");
      }
      const be = backend();
      setUartStatus(`Подключено (${be === 'cap' ? 'UsbSerial/текст' : 'WebSerial/бинарь'})`);
      logLine("Приемопередатчик подключен.");
      writesDone = 0; capLineBuf = ""; rxCounter = 0;

      // Транспорт контроллеру (не обязателен, но оставим)
      encCtrl.attachTransport({
        backend: (be === 'cap') ? 'cap' : 'webserial',
        write: async (data)=> uart.write(data),
      });

    }catch(e){
      let msg = e?.message || e;
      if (e?.name === "NotFoundError") {
        msg = "Устройство не выбрано в системном диалоге";
      }
      // Делаем текст ошибки дружелюбным
      msg = normalizeUartErrorMessage(msg);

      setUartStatus(`Ошибка подключения: ${msg}`);
      logLine(`Ошибка подключения: ${msg}`);
      uartConnected = false;
      engine.setSendEnabled(false);
    }
  }else{
    try{ await uart?.disconnect(); }catch(_){}
    uartConnected = false;
    engine.setSendEnabled(false);
    if (els.btnConnect){
      els.btnConnect.textContent = "Подключить устройство";
      els.btnConnect.classList.remove("success");
      els.btnConnect.classList.add("danger");
    }
    setUartStatus("Отключено");
    logLine("Приемопередатчик отключен.");
    capLineBuf = ""; rxCounter = 0;
  }
}

// === Отправка/приём ===
async function sendEncodedFrame(plainU8){
  if (!uartConnected || !uart || !plainU8 || plainU8.byteLength===0) return;
  const be = backend();

  try{
    if (encCtrl.isEnabled() && encCtrl.isReady()) {
      const frame = await encCtrl.wrapOutgoing(plainU8); // [0xE2|IV|...]
      if (be === 'cap') {
        const line = "E2:" + b64FromU8(frame) + "\n";
        await uart.write(line);
      } else {
        const framed = framePacketBinary(frame); // опционально 2B длины
        await uart.write(framed);
      }
    } else {
      // без шифрования: C2
      if (be === 'cap') {
        const line = "C2:" + b64FromU8(plainU8) + "\n";
        await uart.write(line);
      } else {
        const framed = framePacketBinary(plainU8);
        await uart.write(framed);
      }
    }
    writesDone++;
    if (SEND_DELAY_MS>0) await new Promise(r=>setTimeout(r,SEND_DELAY_MS));
  }catch(e){
    console.error("UART write:",e);
    logLine(`Ошибка UART write: ${e?.message||e}`);
  }
}

function handleUartData(ab){
  const be = backend();
  const u8 = ab instanceof Uint8Array ? ab : new Uint8Array(ab || 0);
  rxCounter += u8.byteLength;

  if (be === 'cap') {
    // ТЕКСТОВЫЙ РЕЖИМ (UsbSerial)
    const chunk = td.decode(u8);
    capLineBuf += chunk;
    const lines = capLineBuf.split(/\r?\n/);
    capLineBuf = lines.pop();

    for (const line of lines) {
      if (!line) continue;

      // сначала пробуем E2 без рукопожатия
      encCtrl.onTextLine(line).then((r)=>{
        if (r.handled){
          if (r.plaintext) {
            engine.appendRxEncoded(r.plaintext);
          }
          return;
        }
        // legacy: C2:<b64>
        if (line.startsWith("C2:")) {
          try {
            engine.appendRxEncoded(u8FromB64(line.slice(3).trim()));
          }
          catch(e){
            console.warn("C2 parse error:",e);
            logLine("C2 parse error");
          }
        } else {
          // Прочий текст → в общий журнал (с временем)
          logLine(line);
        }
      });
    }
    setUartStatus(`Подключено (UsbSerial) · принято ${rxCounter} байт (текст)`);
  } else {
    // БИНАРНЫЙ РЕЖИМ (Web Serial)
    encCtrl.onBinary(u8).then((r)=>{
      if (r.handled){
        if (r.plaintext) {
          engine.appendRxEncoded(r.plaintext);
        }
      } else {
        // без шифрования — скармливаем сырой кодек-кадр
        engine.appendRxEncoded(u8);
      }
    });
    setUartStatus(`Подключено (WebSerial) · принято ${rxCounter} байт`);
  }
}

// === Надёжный запуск ===
function boot(){
  try { initApp(); }
  catch(e){
    console.error("boot/init error:", e);
    showToast("Ошибка инициализации: "+(e?.message||e), "err", 3000);
    logLine("Ошибка инициализации: "+(e?.message||e));
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once:true });
} else {
  boot();
}
