import { useRef, useState } from 'preact/hooks';

// Speech-to-text with the browser's SpeechRecognition (webkit-prefixed on iOS Safari).
// Hidden entirely where it isn't available.
//
// iOS bug (WebKit #225298 and related reports): once the page has played audio (our replies are
// read aloud), a later recognition can hang silently, firing no result, error or end event.
// So: one recognizer is reused, speech is cancelled before listening, and a watchdog gives up if
// the microphone hasn't started within a couple of seconds, reporting 'stuck' so the screen can
// fall back to the keyboard's own dictation (which isn't affected).

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

type W = { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
const Ctor = (window as unknown as W).SpeechRecognition ?? (window as unknown as W).webkitSpeechRecognition;
const STARTUP_TIMEOUT_MS = 2500;

/** error: '' | 'no-speech' | 'not-allowed' | 'stuck' | other browser error codes. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const rec = useRef<Rec | null>(null);
  const session = useRef(0);

  function recognizer(): Rec {
    if (!rec.current) {
      const r = new Ctor!();
      r.lang = 'en-US';
      r.interimResults = true;
      r.continuous = false;
      rec.current = r;
    }
    return rec.current;
  }

  function start() {
    if (!Ctor) return;
    setError('');
    window.speechSynthesis?.cancel();
    const id = ++session.current;
    let heard = false;
    let started = false;
    setListening(true);

    const r = recognizer();
    r.onstart = r.onaudiostart = () => {
      started = true;
    };
    r.onresult = (e) => {
      if (id !== session.current) return;
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      if (text.trim()) heard = true;
      onText(text);
    };
    r.onend = () => {
      if (id !== session.current) return;
      setListening(false);
      if (!heard) setError((prev) => prev || 'no-speech');
    };
    r.onerror = (e) => {
      if (id !== session.current) return;
      setListening(false);
      if (e.error !== 'aborted') setError(e.error === 'service-not-allowed' ? 'not-allowed' : e.error);
    };

    try {
      r.start();
    } catch {
      // Still busy from last time: start over with a fresh recognizer.
      try {
        r.abort?.();
      } catch {
        // ignore
      }
      rec.current = null;
      try {
        recognizer().start();
      } catch {
        setListening(false);
        setError('stuck');
        return;
      }
    }

    // The iOS hang: no start event at all. Give up and let the screen offer keyboard dictation.
    setTimeout(() => {
      if (id !== session.current || started || heard) return;
      session.current++;
      try {
        rec.current?.abort?.();
      } catch {
        // ignore
      }
      rec.current = null;
      setListening(false);
      setError('stuck');
    }, STARTUP_TIMEOUT_MS);
  }

  function stop() {
    session.current++;
    setListening(false);
    try {
      rec.current?.stop();
    } catch {
      // Already finished.
    }
  }

  return { supported: !!Ctor, listening, error, start, stop };
}
