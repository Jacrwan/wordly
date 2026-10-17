import { utterance, type Lang } from './engine';

// One-off speech: a word's pronunciation or a single sentence.

let audio: HTMLAudioElement | null = null;

export function speak(text: string, lang: Lang, rate = 1): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    synth.cancel();
    const u = utterance(text, lang, rate);
    u.onend = u.onerror = () => resolve();
    synth.speak(u);
  });
}

/** The Wikimedia recording when there is one, otherwise the device's English voice. */
export async function pronounce(word: string, url?: string): Promise<void> {
  if (url) {
    try {
      audio?.pause();
      audio = new Audio(url);
      await audio.play();
      return;
    } catch {
      // Blocked or failed to load: fall through to the device voice.
    }
  }
  await speak(word, 'en-US', 0.9);
}

// iOS loads voices lazily; touching the list early makes the first speak() pick the right one.
window.speechSynthesis?.getVoices();
