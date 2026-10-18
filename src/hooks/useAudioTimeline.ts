import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { setMediaSession } from '../speech/engine';

// One audio file played by a single <audio> element, split into numbered parts (words or
// sentences) by their start times. Audio files keep playing with the screen locked or the app
// in the background on iPhone (docs/ios-audio-findings.md), and the lock-screen controls
// (Media Session) step between parts.

export interface Timeline {
  audio: Blob; // WAV
  starts: number[]; // seconds, one per part
  ends?: number[]; // seconds; needed only for stopping after each part
}

export interface TimelineOptions {
  rate: number;
  loop: boolean;
  /** Pause at the end of every part (loop then repeats that part). */
  stopAfterEach?: boolean;
  /** Lock-screen title and subtitle for a part. */
  label: (part: number) => { title: string; artist?: string };
}

export function useAudioTimeline(tl: Timeline, opts: TimelineOptions) {
  const el = useMemo(() => new Audio(), []);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(false);
  const posRef = useRef(0);
  const o = useRef(opts);
  o.current = opts;

  const n = tl.starts.length;
  const posAt = (time: number) => {
    let i = 0;
    while (i + 1 < n && time >= tl.starts[i + 1] - 0.05) i++;
    return i;
  };
  const moveTo = (p: number) => {
    posRef.current = p;
    setPos(p);
  };
  const seekTo = (p: number) => {
    const next = o.current.loop ? (p + n) % n : Math.max(0, Math.min(n - 1, p));
    el.currentTime = next === 0 ? 0 : tl.starts[next];
    moveTo(next);
  };
  const play = () => {
    setPlayError(false);
    void el.play().catch(() => setPlayError(true));
  };
  const pause = () => el.pause();
  const toggle = () => (el.paused ? play() : pause());
  const prev = () => {
    const p = posAt(el.currentTime);
    // Mid-part: restart it; near its start: go to the previous one.
    seekTo(el.currentTime - tl.starts[p] > 1.5 ? p : p - 1);
  };
  const next = () => seekTo(posAt(el.currentTime) + 1);

  // Stop-after-each: timeupdate fires only every ~250 ms, which overshoots a part's end into the
  // next part (heard as a clipped burst on every loop), so a timer aims at the end itself and
  // timeupdate is only the fallback.
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arm = () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    const end = tl.ends?.[posRef.current];
    if (!o.current.stopAfterEach || el.paused || end === undefined) return;
    const ms = ((end - el.currentTime) / (el.playbackRate || 1)) * 1000;
    stopTimer.current = setTimeout(endReached, Math.max(0, ms));
  };
  /** True when the current part has ended (and playback was stopped or looped). */
  const endReached = (): boolean => {
    const p = posRef.current;
    const end = tl.ends?.[p];
    if (!o.current.stopAfterEach || end === undefined || el.currentTime < end - 0.03) {
      arm();
      return false;
    }
    // Stay on the finished part: play repeats it, ⏭ moves on.
    if (!o.current.loop) el.pause();
    el.currentTime = p === 0 ? 0 : tl.starts[p];
    return true;
  };

  useEffect(() => {
    const url = URL.createObjectURL(tl.audio);
    el.src = url;
    el.preload = 'auto';
    moveTo(0);
    el.onerror = () => setPlayError(true);
    el.ontimeupdate = () => {
      if (endReached()) return;
      const at = posAt(el.currentTime);
      if (at !== posRef.current) {
        moveTo(at);
        arm();
      }
    };
    el.onseeked = el.onratechange = arm;
    el.onplay = () => {
      arm();
      setPlaying(true);
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
    };
    el.onpause = el.onended = () => {
      setPlaying(false);
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
    };
    // Rate resets when a new file loads in some browsers.
    el.onloadedmetadata = () => (el.playbackRate = o.current.rate);
    return () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      el.pause();
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      el.ontimeupdate = el.onplay = el.onpause = el.onended = el.onloadedmetadata = el.onerror = el.onseeked = el.onratechange = null;
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'none';
        navigator.mediaSession.metadata = null;
        for (const action of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) {
          try { navigator.mediaSession.setActionHandler(action, null); } catch { /* Unsupported action. */ }
        }
      }
    };
  }, [tl]);

  useEffect(() => {
    el.defaultPlaybackRate = opts.rate;
    el.playbackRate = opts.rate;
  }, [opts.rate]);
  // With stop-after-each, looping repeats one part (handled above), not the whole file.
  useEffect(() => {
    el.loop = opts.loop && !opts.stopAfterEach;
    arm();
  }, [opts.loop, opts.stopAfterEach]);

  useEffect(() => {
    const { title, artist } = o.current.label(pos);
    setMediaSession(title, { play, pause, next, prev }, artist);
  }, [pos, tl]);

  return { pos, playing, playError, play, pause, toggle, prev, next, seekTo };
}
