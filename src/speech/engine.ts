// A queue of short utterances read one after another with the Web Speech API.
//
// iOS quirks handled here: speechSynthesis.pause()/resume() are unreliable, so pausing
// cancels and resuming re-speaks the current segment; a speak() right after cancel() can be
// dropped, so there's a short delay; and every segment is short, since long utterances can
// stall. The first play() must come from a tap (iOS blocks speech otherwise).

export type Lang = 'en-US' | 'ko-KR';

export type Segment =
  | { kind: 'say'; text: string; lang: Lang; group: number; part?: string; alt?: boolean }
  | { kind: 'pause'; ms: number; group: number };

export interface QueueState {
  index: number;
  group: number; // e.g. which word / sentence is playing
  part?: string; // e.g. "word" | "ko" | "definition" | "synonyms"
  playing: boolean;
  done: boolean;
}

let preferred: Partial<Record<Lang, string | null>> = {};

/** Voice names chosen in Settings (null = automatic). */
export function setPreferredVoices(v: Partial<Record<Lang, string | null>>): void {
  preferred = v;
}

// macOS ships joke voices that would clutter the list (iPhones don't have them).
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy|deranged|hysterical|pipe organ)\b/i;

export function voicesFor(lang: Lang): SpeechSynthesisVoice[] {
  const synth = window.speechSynthesis;
  if (!synth) return [];
  const prefix = lang.slice(0, 2);
  return synth.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(prefix) && !NOVELTY.test(v.name));
}

export function pickVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  const voices = voicesFor(lang);
  const want = preferred[lang];
  const exact = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-') === lang;
  return (
    (want ? voices.find((v) => v.name === want) : undefined) ??
    voices.find((v) => exact(v) && v.localService && /premium|enhanced|siri/i.test(v.name)) ??
    // Apple's standard natural voices before the character voices (Eddy, Flo, Grandpa…).
    voices.find((v) => exact(v) && /^(yuna|ava|samantha|allison|susan|zoe|nicky)\b/i.test(v.name)) ??
    voices.find((v) => exact(v) && v.localService) ??
    voices.find(exact) ??
    voices[0]
  );
}

/** A second voice for the same language (e.g. the other podcast host), if the device has one. */
export function altVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  const main = pickVoice(lang);
  const others = voicesFor(lang).filter((v) => v.name !== main?.name && v.lang.replace('_', '-') === lang);
  return others.find((v) => v.localService && /daniel|aaron|fred|alex|tom|reed|rocko/i.test(v.name)) ?? others.find((v) => v.localService) ?? others[0];
}

export function utterance(text: string, lang: Lang, rate: number, alt = false): SpeechSynthesisUtterance {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = rate;
  const voice = (alt && altVoice(lang)) || pickVoice(lang);
  if (voice) u.voice = voice;
  return u;
}

export class SpeechQueue {
  private segments: Segment[] = [];
  private index = 0;
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private playing = false;
  private finished = false;
  rate = 1;
  loop = false;
  /** Stop after each group (sentence-by-sentence mode). */
  stopAfterGroup = false;
  onChange: (s: QueueState) => void = () => {};

  load(segments: Segment[], startIndex = 0): void {
    this.stop();
    this.segments = segments;
    this.index = Math.min(startIndex, Math.max(0, segments.length - 1));
    this.finished = false;
    this.emit();
  }

  get state(): QueueState {
    const seg = this.segments[this.index];
    return {
      index: this.index,
      group: seg?.group ?? 0,
      part: seg?.kind === 'say' ? seg.part : undefined,
      playing: this.playing,
      done: this.finished,
    };
  }

  play(): void {
    if (!this.segments.length) return;
    if (this.finished) {
      this.index = 0;
      this.finished = false;
    }
    this.playing = true;
    this.emit();
    this.speakCurrent();
  }

  pause(): void {
    this.playing = false;
    this.halt();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  stop(): void {
    this.playing = false;
    this.halt();
  }

  /** Jump to the first segment of another group (word or sentence). */
  jumpToGroup(group: number): void {
    const i = this.segments.findIndex((s) => s.group === group);
    if (i < 0) return;
    this.index = i;
    this.finished = false;
    this.emit();
    if (this.playing) this.speakCurrent();
  }

  nextGroup(): void {
    const g = this.state.group;
    const i = this.segments.findIndex((s, j) => j > this.index && s.group !== g);
    if (i >= 0) this.jumpToGroup(this.segments[i].group);
    else if (this.loop && this.segments.length) this.jumpToGroup(this.segments[0].group);
  }

  prevGroup(): void {
    const g = this.state.group;
    const start = this.segments.findIndex((s) => s.group === g);
    // Mid-group: restart this group; at its start: go to the previous one.
    if (this.index > start) return this.jumpToGroup(g);
    const prev = this.segments[start - 1];
    this.jumpToGroup(prev ? prev.group : g);
  }

  private halt(): void {
    this.token++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    window.speechSynthesis?.cancel();
  }

  private emit(): void {
    this.onChange(this.state);
  }

  private speakCurrent(): void {
    this.halt();
    const t = this.token;
    const seg = this.segments[this.index];
    if (!seg) return this.endReached();
    if (seg.kind === 'pause') {
      this.timer = setTimeout(() => t === this.token && this.advance(), seg.ms / this.rate);
      return;
    }
    // A short gap after cancel(): iOS can drop an utterance spoken immediately after it.
    this.timer = setTimeout(() => {
      if (t !== this.token) return;
      const u = utterance(seg.text, seg.lang, this.rate, seg.alt);
      u.onend = u.onerror = () => t === this.token && this.advance();
      window.speechSynthesis.speak(u);
    }, 60);
  }

  private advance(): void {
    const group = this.segments[this.index]?.group;
    this.index++;
    const next = this.segments[this.index];
    if (this.stopAfterGroup && (!next || next.group !== group)) {
      // Sentence mode: stay on the finished sentence (loop repeats it).
      this.index = this.segments.findIndex((s) => s.group === group);
      if (this.loop) return this.speakCurrent();
      this.playing = false;
      this.emit();
      return;
    }
    if (!next) return this.endReached();
    this.emit();
    this.speakCurrent();
  }

  private endReached(): void {
    if (this.loop && this.segments.length) {
      this.index = 0;
      this.emit();
      this.speakCurrent();
      return;
    }
    this.playing = false;
    this.finished = true;
    this.index = Math.max(0, this.segments.length - 1);
    this.emit();
  }
}

/** Lock-screen / headphone controls where the platform supports them. */
export function setMediaSession(title: string, handlers: { play: () => void; pause: () => void; next: () => void; prev: () => void }): void {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.metadata = new MediaMetadata({ title, artist: 'Wordly' });
    ms.setActionHandler('play', handlers.play);
    ms.setActionHandler('pause', handlers.pause);
    ms.setActionHandler('nexttrack', handlers.next);
    ms.setActionHandler('previoustrack', handlers.prev);
  } catch {
    // Not supported for this kind of playback.
  }
}
