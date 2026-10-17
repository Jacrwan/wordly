import { useRef, useState } from 'preact/hooks';

// Speech-to-text with the browser's SpeechRecognition (webkit-prefixed on iOS Safari).
// Hidden entirely where it isn't available.
//
// iOS: after speechSynthesis has read something aloud, the audio session stays in playback
// mode and a new recognition can silently hear nothing. So any speech is cancelled first, the
// previous recognizer is aborted, and recognition starts after a short pause.

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

type W = { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
const Ctor = (window as unknown as W).SpeechRecognition ?? (window as unknown as W).webkitSpeechRecognition;

/** error: '' | 'no-speech' | 'not-allowed' | other browser error codes. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const rec = useRef<Rec | null>(null);
  const session = useRef(0);

  function start() {
    if (!Ctor) return;
    setError('');
    window.speechSynthesis?.cancel();
    try {
      rec.current?.abort?.();
    } catch {
      // Already finished.
    }
    rec.current = null;
    const id = ++session.current;
    setListening(true);
    // Give iOS a moment to hand the audio session back to the microphone.
    setTimeout(() => {
      if (id !== session.current) return;
      const r = new Ctor();
      let heard = false;
      r.lang = 'en-US';
      r.interimResults = true;
      r.continuous = false;
      r.onresult = (e) => {
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
      rec.current = r;
      try {
        r.start();
      } catch {
        setListening(false);
        setError('start-failed');
      }
    }, 250);
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
