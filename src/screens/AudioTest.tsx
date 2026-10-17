import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Page } from '../components/Layout';
import { setMediaSession, SpeechQueue, type Segment } from '../speech/engine';
import { useApp } from '../state';

// Checks whether audio keeps playing when the iPhone screen locks or the app goes to the
// background: (A) Web Speech, as the player and reader use; (B) an audio file in <audio>,
// the way Gemini TTS episodes will play. Each test measures what happened while hidden.

interface Hidden {
  hiddenAt: number | null;
  shownAt: number | null;
}

function useHiddenWindow(): Hidden {
  const [w, setW] = useState<Hidden>({ hiddenAt: null, shownAt: null });
  useEffect(() => {
    const on = () => setW((p) => (document.hidden ? { hiddenAt: Date.now(), shownAt: null } : { ...p, shownAt: Date.now() }));
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return w;
}

/** A WAV of beeps: one per second, a double beep every 10 s (8 kHz, 8-bit mono). */
function beepWav(seconds: number): Blob {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const sec = Math.floor(t);
    const inSec = t - sec;
    const tenth = sec % 10 === 0;
    const on = inSec < 0.12 || (tenth && inSec > 0.2 && inSec < 0.32);
    const f = tenth ? 1320 : 880;
    v.setUint8(44 + i, on ? 128 + Math.round(60 * Math.sin(2 * Math.PI * f * t)) : 128);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function AudioTest() {
  const { t } = useApp();
  const hidden = useHiddenWindow();
  return (
    <Page title={t('audiotest.title')} back="about">
      <p class="small">{t('audiotest.intro')}</p>
      <SpeechTest hidden={hidden} />
      <FileTest hidden={hidden} />
      <p class="muted small">{t('audiotest.report')}</p>
    </Page>
  );
}

function SpeechTest({ hidden }: { hidden: Hidden }) {
  const { t } = useApp();
  const queue = useMemo(() => new SpeechQueue(), []);
  // Numbers 1–300 with a pause after each: easy to hear whether counting continues.
  const segs = useMemo(() => {
    const out: Segment[] = [];
    for (let i = 1; i <= 300; i++) {
      out.push({ kind: 'say', text: String(i), lang: 'en-US', group: i, part: 'n' });
      out.push({ kind: 'pause', ms: 700, group: i });
    }
    return out;
  }, []);
  const spoken = useRef<{ n: number; at: number }[]>([]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    queue.onChange = (s) => {
      setPlaying(s.playing);
      if (s.part === 'n' && spoken.current[spoken.current.length - 1]?.n !== s.group) {
        spoken.current.push({ n: s.group, at: Date.now() });
        setCurrent(s.group);
      }
    };
    return () => queue.stop();
  }, []);

  const start = () => {
    spoken.current = [];
    queue.load(segs);
    queue.play();
    setMediaSession('Wordly speech test', { play: () => queue.play(), pause: () => queue.pause(), next: () => {}, prev: () => {} });
  };

  const result = summarize(spoken.current, hidden);
  return (
    <section class="card">
      <h2>{t('audiotest.speech')}</h2>
      <p class="muted small">{t('audiotest.speechHelp')}</p>
      <p class="test-counter">{current || '–'}</p>
      <div class="row">
        <button class="btn primary" onClick={start} disabled={playing}>{t('audiotest.start')}</button>
        <button class="btn ghost" onClick={() => queue.stop()} disabled={!playing}>{t('audiotest.stop')}</button>
      </div>
      {result && <p class="status small">{result}</p>}
    </section>
  );

  function summarize(list: { n: number; at: number }[], h: Hidden): string | null {
    if (!h.hiddenAt || !h.shownAt || !list.length) return null;
    const during = list.filter((x) => x.at > h.hiddenAt! && x.at < h.shownAt!);
    const away = Math.round((h.shownAt - h.hiddenAt) / 1000);
    return during.length
      ? t('audiotest.speechKept', { away, n: during.length })
      : t('audiotest.speechStopped', { away, n: list.filter((x) => x.at <= h.hiddenAt!).pop()?.n ?? 0 });
  }
}

function FileTest({ hidden }: { hidden: Hidden }) {
  const { t } = useApp();
  const audio = useRef<HTMLAudioElement | null>(null);
  const startedAt = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [atHide, setAtHide] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => audio.current && setPos(Math.floor(audio.current.currentTime)), 500);
    return () => {
      clearInterval(id);
      audio.current?.pause();
    };
  }, []);
  useEffect(() => {
    if (hidden.hiddenAt && !hidden.shownAt && audio.current) setAtHide(audio.current.currentTime);
  }, [hidden.hiddenAt, hidden.shownAt]);

  async function start() {
    audio.current?.pause();
    const el = new Audio(URL.createObjectURL(beepWav(180)));
    audio.current = el;
    el.onended = () => setPlaying(false);
    startedAt.current = Date.now();
    await el.play();
    setPlaying(true);
    setMediaSession('Wordly audio test', { play: () => el.play(), pause: () => el.pause(), next: () => {}, prev: () => {} });
  }

  let result: string | null = null;
  if (hidden.hiddenAt && hidden.shownAt && atHide !== null && audio.current) {
    const away = (hidden.shownAt - hidden.hiddenAt) / 1000;
    const progressed = audio.current.currentTime - atHide;
    result = progressed >= away - 3
      ? t('audiotest.fileKept', { away: Math.round(away) })
      : t('audiotest.fileStopped', { away: Math.round(away), played: Math.max(0, Math.round(progressed)) });
  }

  return (
    <section class="card">
      <h2>{t('audiotest.file')}</h2>
      <p class="muted small">{t('audiotest.fileHelp')}</p>
      <p class="test-counter">{playing ? `${pos}s` : '–'}</p>
      <div class="row">
        <button class="btn primary" onClick={start} disabled={playing}>{t('audiotest.start')}</button>
        <button class="btn ghost" onClick={() => { audio.current?.pause(); setPlaying(false); }} disabled={!playing}>{t('audiotest.stop')}</button>
      </div>
      {result && <p class="status small">{result}</p>}
    </section>
  );
}
