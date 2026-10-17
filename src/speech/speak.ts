// Pronunciation: the Wikimedia recording when there is one, otherwise the device's voice.

let audio: HTMLAudioElement | null = null;

export function speak(text: string, lang: 'en-US' | 'ko-KR', rate = 1): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.onend = u.onerror = () => resolve();
    synth.speak(u);
  });
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  return (
    voices.find((v) => v.lang.replace('_', '-') === lang && v.localService) ??
    voices.find((v) => v.lang.replace('_', '-') === lang) ??
    voices[0]
  );
}

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
