import { useRef, useState } from 'preact/hooks';

// Voice input by recording the microphone ourselves (getUserMedia + Web Audio) instead of the
// browser's SpeechRecognition, which on iOS freezes after the page has played audio. The
// recording stops on its own after a short silence once speech was heard (or on a second tap)
// and is returned as a 16 kHz mono WAV, base64-encoded, for Gemini to transcribe.

const TARGET_RATE = 16000;
const SILENCE_MS = 1600; // stop after this much quiet following speech
const MAX_MS = 30_000;
const NO_SPEECH_MS = 8000; // give up if nothing was said at all
const SPEECH_RMS = 0.025; // loudness that counts as speech

export type RecorderState = 'idle' | 'recording' | 'error';

export function useRecorder(onDone: (wavBase64: string, seconds: number) => void) {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0); // 0–1, for a simple input meter
  const stopRef = useRef<((send: boolean) => void) | null>(null);

  const supported = !!navigator.mediaDevices?.getUserMedia && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);

  async function start() {
    if (!supported || stopRef.current) return;
    setError('');
    window.speechSynthesis?.cancel(); // don't record the app's own voice
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx(); // created inside the tap, so iOS allows it
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      ctx.close();
      setError((e as DOMException).name === 'NotAllowedError' ? 'not-allowed' : 'no-mic');
      setState('error');
      return;
    }
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but is what iOS Safari reliably supports here.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    const began = performance.now();
    let lastLoud = 0;
    let heard = false;
    let finished = false;

    const finish = (send: boolean) => {
      if (finished) return;
      finished = true;
      stopRef.current = null;
      proc.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop()); // releases the mic so playback returns to the speaker
      const rate = ctx.sampleRate;
      ctx.close();
      setState('idle');
      setLevel(0);
      if (!send) return;
      if (!heard) {
        setError('no-speech');
        setState('error');
        return;
      }
      const samples = merge(chunks);
      onDone(toWavBase64(downsample(samples, rate, TARGET_RATE), TARGET_RATE), samples.length / rate);
    };
    stopRef.current = finish;

    proc.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      chunks.push(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, rms * 12));
      const now = performance.now();
      if (rms > SPEECH_RMS) {
        heard = true;
        lastLoud = now;
      }
      const elapsed = now - began;
      if ((heard && now - lastLoud > SILENCE_MS) || elapsed > MAX_MS || (!heard && elapsed > NO_SPEECH_MS)) finish(true);
    };
    source.connect(proc);
    proc.connect(ctx.destination); // required for onaudioprocess to fire; output is silent
    setState('recording');
  }

  /** Stop and send what was recorded (second tap). */
  function stop() {
    stopRef.current?.(true);
  }

  function cancel() {
    stopRef.current?.(false);
  }

  return { supported, state, error, level, start, stop, cancel };
}

function merge(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the samples that fold into each output sample (simple low-pass).
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function toWavBase64(samples: Float32Array, rate: number): string {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  // base64 in chunks (a single String.fromCharCode call would overflow the stack).
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
