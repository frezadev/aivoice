// recorder-worklet.js
// Simple AudioWorkletProcessor that forwards PCM float32 frames to main thread.
// It also computes a simple peak for quick waveform display.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 128; // usually process() receives 128 frames per call
  }

  process(inputs /*, outputs, parameters */) {
    const input = inputs[0];
    if (input && input[0]) {
      // copy channel data
      const channelData = input[0]; // Float32Array
      // send raw Float32Array (copy) to main thread
      // Worklet ports can transfer MessagePort/ArrayBuffer; Float32Array.buffer is transferable
      const buf = new Float32Array(channelData.length);
      buf.set(channelData);
      this.port.postMessage({ audioBuffer: buf.buffer }, [buf.buffer]);
      // also send a simple peak (for quick visual indicator)
      let peak = 0;
      for (let i = 0; i < channelData.length; i++) {
        const v = Math.abs(channelData[i]);
        if (v > peak) peak = v;
      }
      this.port.postMessage({ peak });
    }
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
