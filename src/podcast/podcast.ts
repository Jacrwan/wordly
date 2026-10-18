import { chatModels, connFrom, generateJSON, GeminiError, type Conn } from '../ai/gemini';
import { RATE, synthesize, ttsModels, wavBlob } from '../ai/tts';
import { silenceBursts, speechSpan } from '../speech/edges';
import { pickTargets, type Target } from '../chat/chat';
import { db, type Level, type Podcast, type Settings } from '../db/schema';

// Podcast episodes: Gemini writes a 3–5 minute two-host dialogue around the learner's saved
// words, then Gemini TTS voices it in a few chunks that are joined into one WAV and stored in
// IndexedDB (replays never regenerate). If TTS isn't available, the episode plays with the
// device's voices instead. Audio files keep playing with the screen locked (see
// docs/ios-audio-findings.md), which Web Speech does not.

export const HOSTS = { A: 'Mina', B: 'Jake' } as const;
export type Speaker = keyof typeof HOSTS;
const VOICES: Record<Speaker, string> = { A: 'Kore', B: 'Puck' };

export interface Line {
  speaker: Speaker;
  text: string;
  words: string[]; // saved-word keys used in this line
}

export interface Script {
  lines: Line[];
  timing?: [number, number][]; // per line, seconds in the audio (TTS episodes)
  duration?: number;
}

const MIN_WORDS = 3;
const MAX_WORDS = 12;
const CHUNK_CHARS = 1200; // ≈ 80–100 s of speech per TTS request

const LEVEL_PROMPT: Record<Level, string> = {
  beginner:
    'Beginner: the hosts speak mostly in Korean, like a friendly Korean radio show teaching English. Each target word is ' +
    'said in English with its Korean meaning, then used in one short, slow, simple English sentence that a host repeats. ' +
    'Keep English parts very simple.',
  intermediate:
    'Intermediate: a natural English conversation. The FIRST time each target word appears, a host adds its Korean ' +
    'meaning right after it (e.g. "the deposit — 보증금 — is due Friday"). After that, English only.',
  advanced: 'Advanced: a natural, fluent all-English podcast conversation at normal speed. No Korean.',
};

const SCRIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'short episode title in Korean' },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          speaker: { type: 'STRING', enum: ['A', 'B'] },
          text: { type: 'STRING' },
          words: { type: 'ARRAY', items: { type: 'STRING' }, description: 'target words used in this line, as given' },
        },
        required: ['speaker', 'text', 'words'],
        propertyOrdering: ['speaker', 'text', 'words'],
      },
    },
  },
  required: ['title', 'lines'],
  propertyOrdering: ['title', 'lines'],
};

export async function podcastWords(): Promise<Target[]> {
  return (await pickTargets(MAX_WORDS)).slice(0, MAX_WORDS);
}

async function writeScript(conn: Conn, settings: Settings, words: Target[], level: Level) {
  const p = settings.profile;
  const models = [settings.models?.long, ...chatModels(settings.models)].filter((m): m is string => !!m);
  const { data } = await generateJSON<{ title: string; lines: { speaker: string; text: string; words: string[] }[] }>(conn, {
    models,
    system:
      `You write short, warm, natural two-host podcast episodes for Korean adults learning English. Host A is ${HOSTS.A} ` +
      `(female), host B is ${HOSTS.B} (male). They chat about everyday life in a way that naturally uses the target words, ` +
      'with a short intro and a friendly sign-off. No sound effects, no stage directions, no markdown.',
    prompt: [
      `Listener: ${[p.ageRange && `in their ${p.ageRange}`, p.occupation].filter(Boolean).join(', ') || 'adult learner'}`,
      `Target words (use every one at least once, more if natural): ${words.map((w) => `${w.display} (${w.ko.join(', ')})`).join('; ')}`,
      LEVEL_PROMPT[level],
      'Length: 3–5 minutes when read aloud (about 500–700 words in total), 30–50 short lines alternating between A and B.',
      'For each line, list the target words it uses in "words".',
    ].join('\n'),
    schema: SCRIPT_SCHEMA,
    temperature: 0.9,
    timeoutMs: 120_000,
  });
  const keys = new Map(words.map((w) => [w.display.toLowerCase(), w.key]));
  const lines: Line[] = (data.lines ?? [])
    .filter((l) => l?.text?.trim())
    .map((l) => ({
      speaker: l.speaker === 'B' ? 'B' : 'A',
      text: l.text.trim(),
      words: (l.words ?? []).map((w) => keys.get(w.toLowerCase()) ?? w.toLowerCase()).filter((k) => words.some((w) => w.key === k)),
    }));
  if (lines.length < 6) throw new Error('script too short');
  return { title: data.title?.trim() || words.slice(0, 3).map((w) => w.display).join(', '), lines };
}

// ---------------------------------------------------------------- TTS

function chunks(lines: Line[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let size = 0;
  lines.forEach((l, i) => {
    if (cur.length && size + l.text.length > CHUNK_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += l.text.length;
  });
  if (cur.length) out.push(cur);
  return out;
}

/** One chunk of dialogue → 16-bit PCM samples (24 kHz mono). */
async function speakChunk(conn: Conn, models: string[], lines: Line[]): Promise<Int16Array> {
  const body = {
    contents: [{ role: 'user', parts: lines.map((l) => ({ text: l.text, speechMetadata: { speaker: HOSTS[l.speaker] } })) }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: (['A', 'B'] as Speaker[]).map((s) => ({
            speaker: HOSTS[s],
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICES[s] } },
          })),
        },
      },
    },
  };
  return (await synthesize(conn, models, body)).pcm;
}

// ---------------------------------------------------------------- background job

export type JobState =
  | { status: 'idle' }
  | { status: 'script' }
  | { status: 'audio'; done: number; total: number }
  | { status: 'done'; id: number; fallback: boolean }
  | { status: 'error'; message: string };

let job: JobState = { status: 'idle' };
const listeners = new Set<() => void>();
const set = (s: JobState) => {
  job = s;
  listeners.forEach((l) => l());
};

export const jobState = () => job;
export function onJob(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Creates an episode in the background (keeps going if the user leaves the podcast screen). */
export async function createEpisode(settings: Settings, level: Level): Promise<void> {
  if (job.status === 'script' || job.status === 'audio') return;
  const conn = connFrom(settings);
  if (!conn || !settings.models) return set({ status: 'error', message: 'unavailable' });
  try {
    const words = await podcastWords();
    if (words.length < MIN_WORDS) return set({ status: 'error', message: 'few-words' });
    set({ status: 'script' });
    const { title, lines } = await writeScript(conn, settings, words, level);

    // Voice it chunk by chunk; any failure falls back to device voices for the whole episode.
    const groups = chunks(lines);
    const models = ttsModels(settings);
    const pcm: Int16Array[] = [];
    const timing: [number, number][] = [];
    let fallback = !models.length;
    let t = 0;
    for (const [i, g] of groups.entries()) {
      if (fallback) break;
      set({ status: 'audio', done: i, total: groups.length });
      try {
        const raw = await speakChunk(conn, models, g.map((j) => lines[j]));
        const audio = raw.subarray(...speechSpan(raw)); // drop static at the chunk's edges
        pcm.push(audio);
        // Line timing within a chunk: proportional to text length (good enough to follow along).
        const secs = audio.length / RATE;
        const total = g.reduce((n, j) => n + lines[j].text.length, 0) || 1;
        for (const j of g) {
          const d = (secs * lines[j].text.length) / total;
          timing[j] = [t, t + d];
          t += d;
        }
      } catch (e) {
        console.warn('TTS failed, using device voices', e);
        fallback = true;
      }
    }

    const script: Script = fallback ? { lines } : { lines, timing, duration: t };
    const row: Podcast = {
      title,
      level,
      words: words.map((w) => w.key),
      script,
      audio: fallback ? null : wavBlob(pcm),
      audioSource: fallback ? 'webspeech' : 'gemini',
      cleaned: true,
      createdAt: Date.now(),
    };
    const id = await db.podcasts.add(row);
    set({ status: 'done', id, fallback });
  } catch (e) {
    set({ status: 'error', message: e instanceof GeminiError && e.kind === 'rate-limit' ? 'busy' : (e as Error).message });
  }
}

/**
 * The episode's audio without the bursts Gemini TTS leaves at the end of each chunk. Episodes
 * made before chunks were cleaned are fixed once (bursts silenced in place, so the transcript
 * timing still matches) and saved.
 */
export async function episodeAudio(ep: Podcast): Promise<Blob> {
  if (!ep.audio || ep.cleaned) return ep.audio!;
  const pcm = new Int16Array((await ep.audio.arrayBuffer()).slice(44));
  const audio = silenceBursts(pcm) ? wavBlob([pcm]) : ep.audio;
  if (ep.id !== undefined) await db.podcasts.update(ep.id, { audio, cleaned: true }).catch(() => {});
  return audio;
}

export function resetJob(): void {
  if (job.status === 'done' || job.status === 'error') set({ status: 'idle' });
}
