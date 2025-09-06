import React, { useEffect, useRef, useState } from "react";

const WS_PORT = "localhost:8080";

/* ---------- helpers (unchanged logic) ---------- */
function floatTo16BitPCM(float32Array: Float32Array) {
  const l = float32Array.length;
  const buffer = new ArrayBuffer(l * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < l; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Int16Array(buffer);
}

function downsampleBuffer(
  buffer: Float32Array,
  sampleRate: number,
  outSampleRate = 16000
) {
  if (outSampleRate === sampleRate) return buffer;
  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0,
      count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function int16ToFloat32Array(int16: Int16Array) {
  const l = int16.length;
  const float32 = new Float32Array(l);
  for (let i = 0; i < l; i++) {
    const val = int16[i];
    float32[i] = val < 0 ? val / 0x8000 : val / 0x7fff;
  }
  return float32;
}

function encodeInt16ToBase64(int16: Int16Array) {
  let binary = "";
  for (let i = 0; i < int16.length; i++) {
    const val = int16[i];
    const low = val & 0xff;
    const high = (val >> 8) & 0xff;
    binary += String.fromCharCode(low) + String.fromCharCode(high);
  }
  return btoa(binary);
}

/* ---------- component ---------- */
export default function VoiceChatWorklet() {
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);

  // audio refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const zeroGainRef = useRef<GainNode | null>(null);

  // playback
  const playQueueRef = useRef<Float32Array[]>([]);
  const scheduledEndRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // analyser + visualizers
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserConnectedRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null); // output visualizer RAF
  const inputRafRef = useRef<number | null>(null); // input visualizer RAF

  // canvas refs & input buffer
  const visualCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const inputSampleBufferRef = useRef<Float32Array | null>(null);
  const inputPeakRef = useRef<number>(0);

  // batching for upload
  const pcmBatchBufferRef = useRef<Float32Array[]>([]);
  const pcmBatchSizeRef = useRef<number>(0);
  const FLUSH_SIZE = 1600; // ~100ms @16k

  function pushMsg(m: string) {
    setMessages((s) => [...s, `${new Date().toLocaleTimeString()} : ${m}`]);
  }

  /* ---------- WS ---------- */
  function connect() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    const url =
      (location.protocol === "https:" ? "wss" : "ws") + "://" + WS_PORT + "/ws";
    const ws = new WebSocket(url);
    ws.onopen = () => {
      setConnected(true);
      pushMsg("connected");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        // debug
        console.log("onmessage:", msg);
        handleServerMsg(msg);
      } catch {
        console.log("onmessage raw:", ev.data);
      }
    };
    ws.onclose = () => {
      setConnected(false);
      pushMsg("disconnected");
    };
    ws.onerror = (e) => {
      console.error("ws error", e);
    };
    wsRef.current = ws;

    setTimeout(() => {
      startRecording();
    }, 100);
  }

  function disconnect() {
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
    setConnected(false);
    stopRecording();
  }

  /* ---------- Server message handling ---------- */
  function handleServerMsg(msg: any) {
    if (msg.error) {
      pushMsg(msg.error);
      return;
    }

    if (msg.type === "response.output_audio.delta" && msg.delta) {
      const float32 = decodeBase64Pcm16(msg.delta);
      enqueueAndPlay(float32);
      return;
    }
    if (msg.type === "response.content_part.done" && msg.part) {
      pushMsg(msg.part.transcript);
      return;
    }

    // pushMsg("evt: " + (msg.type || JSON.stringify(msg).slice(0, 120)));
  }

  function decodeBase64Pcm16(b64: string): Float32Array {
    const raw = atob(b64);
    const total = raw.length / 2;
    const int16 = new Int16Array(total);
    for (let i = 0; i < total; i++) {
      const low = raw.charCodeAt(i * 2);
      const high = raw.charCodeAt(i * 2 + 1);
      let val = (high << 8) | low;
      if (val >= 0x8000) val = val - 0x10000;
      int16[i] = val;
    }
    return int16ToFloat32Array(int16);
  }

  /* ---------- playback scheduling ---------- */
  function enqueueAndPlay(chunk: Float32Array) {
    playQueueRef.current.push(chunk);
    schedulePlayback();
  }

  function ensureAudioCtx() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      scheduledEndRef.current = audioCtxRef.current.currentTime;
      // create analyser (once)
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      // do NOT connect to destination yet here; will connect once when playback occurs
    } else {
      // resume if suspended (some browsers auto-suspend)
      if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume().catch(() => {});
      }
    }
    return audioCtxRef.current;
  }

  function schedulePlayback() {
    const audioCtx = ensureAudioCtx();
    // make sure analyser connected to destination exactly once (so it can feed visualizer + speakers)
    if (analyserRef.current && !analyserConnectedRef.current) {
      try {
        analyserRef.current.connect(audioCtx.destination);
        analyserConnectedRef.current = true;
        // startOutputVisualizer();
        // startCombinedVisualizer();
      } catch (e) {
        console.warn("analyser connect failed", e);
      }
    }

    // resume context if needed (so playback actually plays)
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }

    if (isPlayingRef.current === false) {
      isPlayingRef.current = true;
    }

    while (playQueueRef.current.length > 0) {
      const chunk = playQueueRef.current.shift() as Float32Array;
      const buffer = audioCtx.createBuffer(1, chunk.length, 16000);
      buffer.getChannelData(0).set(chunk);
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = 1.4;

      // connect: src -> analyser -> destination (analyser already connected to destination)
      src.connect(analyserRef.current!);

      // keep ref so it doesn't get GC'd and so we can optionally stop it
      activeSourcesRef.current.push(src);

      const startAt = Math.max(
        scheduledEndRef.current,
        audioCtx.currentTime + 0.01
      );
      src.start(startAt);
      scheduledEndRef.current = startAt + buffer.duration;

      src.onended = () => {
        // remove from active list and disconnect src
        try {
          src.disconnect();
        } catch {}
        const idx = activeSourcesRef.current.indexOf(src);
        if (idx !== -1) activeSourcesRef.current.splice(idx, 1);

        // when everything finished, flip flag
        if (
          playQueueRef.current.length === 0 &&
          audioCtx.currentTime >= scheduledEndRef.current - 0.05
        ) {
          isPlayingRef.current = false;
        }
      };
    }
  }

  /* ---------- worklet & batching ---------- */
  async function ensureWorkletLoaded() {
    const audioCtx = ensureAudioCtx();
    if (workletNodeRef.current) return workletNodeRef.current;

    try {
      await audioCtx.audioWorklet.addModule("/recorder-worklet.js");
    } catch (e) {
      // fallback blob code (kept small)
      const code = `class RecorderProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0]) {
            const data = input[0];
            const buf = new Float32Array(data.length); buf.set(data);
            this.port.postMessage({ audioBuffer: buf.buffer }, [buf.buffer]);
            let peak = 0;
            for (let i=0;i<data.length;i++){ const v=Math.abs(data[i]); if(v>peak) peak=v; }
            this.port.postMessage({ peak });
          }
          return true;
        }
      }
      registerProcessor('recorder-processor', RecorderProcessor);`;
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(audioCtx, "recorder-processor");

    node.port.onmessage = (ev) => {
      const d = ev.data;
      if (d.audioBuffer) {
        const floatBuf = new Float32Array(d.audioBuffer);

        // store for input waveform
        inputSampleBufferRef.current = floatBuf.slice(
          0,
          Math.min(1024, floatBuf.length)
        );

        // downsample to 16k
        const down = downsampleBuffer(floatBuf, audioCtx.sampleRate, 16000);

        // batch
        pcmBatchBufferRef.current.push(down);
        pcmBatchSizeRef.current += down.length;

        /* console.log(
          "[worklet chunk]",
          floatBuf.length,
          "@",
          audioCtx.sampleRate,
          "->",
          down.length,
          "@16k, batch:",
          pcmBatchSizeRef.current
        ); */

        if (pcmBatchSizeRef.current >= FLUSH_SIZE) {
          flushBatch().catch((e) => console.error("flush err", e));
        }
      }
      if (d.peak !== undefined) {
        inputPeakRef.current = d.peak;
      }
    };

    workletNodeRef.current = node;
    return node;
  }

  async function flushBatch() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn("flushBatch: ws not open");
      return;
    }
    const buffers = pcmBatchBufferRef.current;
    const total = pcmBatchSizeRef.current;
    if (!buffers.length || total === 0) return;

    const merged = new Float32Array(total);
    let off = 0;
    for (const b of buffers) {
      merged.set(b, off);
      off += b.length;
    }
    pcmBatchBufferRef.current = [];
    pcmBatchSizeRef.current = 0;

    const int16 = floatTo16BitPCM(merged);
    const b64 = encodeInt16ToBase64(int16);

    /* console.log(
      "[flushBatch] samples:",
      merged.length,
      "≈",
      Math.round((merged.length / 16000) * 1000),
      "ms"
    ); */
    // pushMsg(`flush ${merged.length} samples`);

    try {
      wsRef.current.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: b64 })
      );
    } catch (e) {
      console.error("ws send err", e);
    }
    await new Promise((res) => setTimeout(res, 60));
  }

  /* ---------- start / stop recording ---------- */
  async function startRecording() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      pushMsg("please connect to /ws server first");
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;

    const audioCtx = ensureAudioCtx();
    const node = await ensureWorkletLoaded();

    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;
    source.connect(node);

    // save zeroGain so we can disconnect
    const zeroGain = audioCtx.createGain();
    zeroGain.gain.value = 0;
    zeroGainRef.current = zeroGain;
    node.connect(zeroGain);
    zeroGain.connect(audioCtx.destination); // keep input path alive (worklet processing)

    setRecording(true);
    pushMsg("recording started");

    // start input waveform RAF if not already started
    // startInputVisualizer();
    startCombinedVisualizer();
  }

  async function stopRecordingInternal() {
    // disconnect input nodes & worklet message handler
    try {
      if (workletNodeRef.current) {
        try {
          workletNodeRef.current.port.onmessage = null;
        } catch {}
        try {
          workletNodeRef.current.disconnect();
        } catch {}
        // keep workletNodeRef as null so next start re-creates it
        workletNodeRef.current = null;
      }
    } catch (e) {
      console.error(e);
    }

    try {
      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch {}
        sourceRef.current = null;
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    } catch (e) {
      console.error(e);
    }

    // also disconnect zeroGain (input path)
    try {
      if (zeroGainRef.current) {
        try {
          zeroGainRef.current.disconnect();
        } catch {}
        zeroGainRef.current = null;
      }
    } catch (e) {
      console.error(e);
    }

    micStreamRef.current = null;
    setRecording(false);
    pushMsg("recording stopped");

    // stop input visualizer RAF
    if (inputRafRef.current) {
      cancelAnimationFrame(inputRafRef.current);
      inputRafRef.current = null;
    }

    // flush batch and commit
    try {
      await flushBatch();
    } catch (e) {
      console.error("flush during stop err", e);
    }
    await new Promise((res) => setTimeout(res, 80));
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: "input_audio_buffer.commit" })
        );
        await new Promise((res) => setTimeout(res, 60));
        wsRef.current.send(JSON.stringify({ type: "response.create" }));
        pushMsg("commit + response.create sent");
      }
    } catch (e) {
      console.error("commit err", e);
    }
  }

  function stopRecording() {
    void stopRecordingInternal();
  }

  function setLog() {
    setShowLog(true);
  }

  function hideLog() {
    setShowLog(false);
  }

  /* ---------- visualizers ---------- */
  function startCombinedVisualizer() {
    const canvas = visualCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const analyser = analyserRef.current;

    const render = () => {
      requestAnimationFrame(render);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // INPUT
      const inputBuf = inputSampleBufferRef.current;
      const inputAmp = inputBuf ? Math.max(...inputBuf.map(Math.abs)) : 0;
      if (inputAmp !== 0) {
        const inputRadius = inputAmp * 80;
        ctx.fillStyle = "#FFDD55"; // kuning
        ctx.beginPath();
        ctx.arc(
          canvas.width / 2,
          canvas.height / 2,
          inputRadius,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }

      // OUTPUT
      if (analyser) {
        const bufferLength = analyser.fftSize;
        const dataArray = new Float32Array(bufferLength);
        analyser.getFloatTimeDomainData(dataArray);
        const outputAmp = Math.max(...dataArray.map(Math.abs));
        const outputRadius = outputAmp * 80;

        ctx.fillStyle = "#00FFAA"; // hijau
        ctx.beginPath();
        ctx.arc(
          canvas.width / 2,
          canvas.height / 2,
          outputRadius,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    };

    render();
  }

  /* ---------- cleanup on unmount ---------- */
  useEffect(() => {
    return () => {
      // disconnect & stop everything
      try {
        workletNodeRef.current?.disconnect();
      } catch {}
      try {
        sourceRef.current?.disconnect();
      } catch {}
      try {
        zeroGainRef.current?.disconnect();
      } catch {}
      if (micStreamRef.current)
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (inputRafRef.current) cancelAnimationFrame(inputRafRef.current);

      // close audio context if exists
      if (audioCtxRef.current) {
        const ac = audioCtxRef.current;
        audioCtxRef.current = null;
        void ac.close().catch(() => {});
      }

      try {
        disconnect();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- UI ---------- */
  return (
    <div style={{ padding: 12, maxWidth: 900 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button
          onClick={() => (connected ? disconnect() : connect())}
          style={{ padding: 10, backgroundColor: connected ? "green" : "red" }}
        >
          {connected ? "Disconnect" : "Connect"}
        </button>

        <button
          onClick={() => (recording ? stopRecording() : startRecording())}
          disabled={!connected}
          style={{ padding: 10, color: !connected ? "black" : "white" }}
        >
          {recording ? "Mute Mic" : "Unmute Mic"}
        </button>

        <button
          onClick={() => (showLog ? hideLog() : setLog())}
          disabled={!connected}
          style={{ padding: 10, color: !connected ? "black" : "white" }}
        >
          {showLog ? "Hide Logs" : "Show Logs"}
        </button>
      </div>
      {recording && (
        <span style={{ marginLeft: 10, fontSize: 12 }}>
          ... you can talk now ...
        </span>
      )}

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <div>
          <canvas ref={visualCanvasRef} width={800} height={300} />
        </div>
      </div>

      <div
        style={{
          padding: 8,
          height: 300,
          width: 800,
          overflow: "auto",
          background: "black",
          display: showLog ? "block" : "none",
        }}
      >
        {messages.map((m, i) => (
          <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
            {m}
          </div>
        ))}
      </div>
    </div>
  );
}
