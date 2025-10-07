// AudioWorklet: сквозной процессор, шлёт копию входа в main thread
// и одновременно выдаёт вход на выход, чтобы граф оставался «живым».

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    const chIn = input && input[0] ? input[0] : null;   // Float32Array длиной 128 (обычно)
    const chOut = output && output[0] ? output[0] : null;

    if (chIn) {
      // Отправляем копию чанка в главный поток
      // ВАЖНО: .slice(0) — чтобы передать независимую копию
      this.port.postMessage(chIn.slice(0));

      // Сквозная передача — чтобы узел был подключён к destination и не засыпал
      if (chOut) chOut.set(chIn);
    } else if (chOut) {
      chOut.fill(0);
    }

    return true; // продолжать обрабатывать
  }
}

registerProcessor("audio-processor", RecorderProcessor);
