import { Fragment, type ComponentChildren, type JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connFrom } from '../ai/gemini';
import { ttsModels } from '../ai/tts';
import { Page } from '../components/Layout';
import { useAudioTimeline } from '../hooks/useAudioTimeline';
import { buildReaderSession, cachedRuns, makeRuns, readerRuns, type ReaderSession, type Run } from '../speech/readerAudio';
import { useApp } from '../state';
import { WordPanel } from './Word';
import { SpeedLoop, Transport } from './Player';

const DRAFT_KEY = 'wordly.reader.text';
const SAMPLE = `I have a doctor's appointment on Tuesday morning. The clinic is near the bank, so I will deposit my rent check on the way.
After that, I need to pick up my prescription at the pharmacy. If the line is long, I might be late for work.`;

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(text: string): void {
  try {
    localStorage.setItem(DRAFT_KEY, text);
  } catch {
    // Private mode or storage blocked: the draft just isn't remembered.
  }
}

/** Paragraphs → sentences, using Intl.Segmenter where available. */
export function splitSentences(text: string): { text: string; paragraphStart: boolean }[] {
  const out: { text: string; paragraphStart: boolean }[] = [];
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const segmenter = Seg ? new Seg('en', { granularity: 'sentence' }) : null;
  for (const para of text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean)) {
    const parts = segmenter
      ? [...segmenter.segment(para)].map((s) => s.segment.trim())
      : para.split(/(?<=[.!?…])\s+/).map((s) => s.trim());
    parts.filter(Boolean).forEach((s, i) => out.push({ text: s, paragraphStart: i === 0 }));
  }
  return out;
}

const WORD = /([A-Za-z]+(?:['’-][A-Za-z]+)*)/;

type Mode = 'continuous' | 'sentence';

export function Reader() {
  const { t } = useApp();
  const [text, setText] = useState(loadDraft);
  const [editing, setEditing] = useState(() => !loadDraft());
  // Set when the user taps 읽기, so voicing starts at once (opening the screen alone spends nothing).
  const [autoMake, setAutoMake] = useState(false);
  const [lookup, setLookup] = useState<string | null>(null);
  const sentences = useMemo(() => splitSentences(text), [text]);

  function done() {
    saveDraft(text);
    setEditing(false);
    setAutoMake(true);
  }

  return (
    <Page title={t('more.reader')} back="more">
      {editing ? (
        <section class="card">
          <textarea class="input reader-input" value={text} rows={10} placeholder={t('reader.placeholder')}
            autocapitalize="sentences" onInput={(e) => setText(e.currentTarget.value)} />
          <div class="row gap-top">
            <button class="btn ghost" onClick={() => setText(SAMPLE)}>{t('reader.sample')}</button>
            <button class="btn primary" disabled={!text.trim()} onClick={done}>{t('reader.read')}</button>
          </div>
        </section>
      ) : (
        <ReaderAudio key={text} sentences={sentences} autoMake={autoMake} onWord={(w) => setLookup(w.replace(/[’]/g, "'"))}
          onEdit={() => { setAutoMake(false); setEditing(true); }} />
      )}

      {lookup && (
        <Sheet onClose={() => setLookup(null)}>
          <WordPanel query={lookup} source="reader" />
        </Sheet>
      )}
    </Page>
  );
}

type Prep =
  | { phase: 'checking' }
  | { phase: 'need'; missing: Run[] }
  | { phase: 'making'; done: number; total: number; waitMs?: number }
  | { phase: 'ready'; session: ReaderSession; partial: boolean };

/** Voices the text with Gemini TTS (cached), then plays it as one audio file. */
function ReaderAudio({ sentences, autoMake, onWord, onEdit }: {
  sentences: { text: string; paragraphStart: boolean }[];
  autoMake: boolean;
  onWord: (w: string) => void;
  onEdit: () => void;
}) {
  const { t, settings } = useApp();
  const [prep, setPrep] = useState<Prep>({ phase: 'checking' });
  const [error, setError] = useState('');
  const conn = connFrom(settings);
  const models = ttsModels(settings);
  const canMake = !!conn && models.length > 0;
  const texts = useMemo(() => sentences.map((s) => s.text), [sentences]);
  const cancel = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const check = async (allowPartial = false) => {
    const runs = await readerRuns(texts);
    const clips = await cachedRuns(runs);
    if (!alive.current) return null;
    const missing = runs.filter((r) => !clips.has(r.key));
    const session = await buildReaderSession(runs, clips);
    if (!alive.current) return null;
    if (session && (!missing.length || allowPartial)) setPrep({ phase: 'ready', session, partial: missing.length > 0 });
    else setPrep({ phase: 'need', missing });
    return missing;
  };

  const make = async (missing: Run[]) => {
    if (!conn || !models.length) return;
    const ctl = new AbortController();
    cancel.current = ctl;
    setError('');
    setPrep({ phase: 'making', done: 0, total: missing.length });
    const res = await makeRuns(conn, models, texts, missing, (p) => alive.current && setPrep({ phase: 'making', ...p }), ctl.signal);
    if (ctl.signal.aborted || !alive.current) return;
    if (res.stopped === 'quota') setError(t(res.made || missing.length < (await readerRuns(texts)).length ? 'reader.audio.quota' : 'player.audio.quotaNone'));
    if (res.stopped === 'error') {
      console.warn('reader audio failed', res.error);
      setError(t('player.audio.error'));
    }
    check(true);
  };

  useEffect(() => {
    alive.current = true;
    check()
      .then((missing) => {
        if (missing?.length && autoMake && canMake) make(missing);
      })
      .catch(() => alive.current && setError(t('player.audio.error')));
    return () => { alive.current = false; cancel.current?.abort(); };
  }, []);

  const textCard = (current: number, onSentence?: (i: number) => void, has?: Set<number>) => (
    <section class="card reader-text" lang="en">
      {sentences.map((s, i) => (
        <Fragment key={i}>
          {s.paragraphStart && i > 0 && <br />}
          {/* Tapping a sentence (not a word) moves playback there. */}
          <span class={`sentence ${i === current ? 'current' : ''} ${has && !has.has(i) ? 'no-audio' : ''}`}
            onClick={() => onSentence?.(i)}>
            {tokens(s.text, onWord)}{' '}
          </span>
        </Fragment>
      ))}
    </section>
  );

  if (prep.phase === 'ready') {
    return (
      <>
        {error && <p class="status error small">{error}</p>}
        <ReaderPlayer session={prep.session} sentences={texts} textCard={textCard} />
        {prep.partial && canMake && (
          <button class="btn ghost block" onClick={() => check().then((m) => { if (m?.length) make(m); })}>{t('reader.audio.makeRest')}</button>
        )}
        <button class="btn ghost block" onClick={onEdit}>{t('reader.edit')}</button>
      </>
    );
  }

  return (
    <>
      <section class="card audio-prep">
        {prep.phase === 'checking' ? (
          <p class="muted center">{t('word.loading')}</p>
        ) : prep.phase === 'making' ? (
          <>
            <progress class="progress" max={prep.total} value={prep.done} />
            <p class="small">{t('reader.audio.making', { done: prep.done, total: prep.total })}</p>
            <p class="muted tiny">{prep.waitMs ? t('player.audio.waiting', { s: Math.ceil(prep.waitMs / 1000) }) : t('player.audio.keepOpen')}</p>
            <button class="btn ghost block" onClick={() => { cancel.current?.abort(); check(true); }}>{t('player.audio.stop')}</button>
          </>
        ) : canMake ? (
          <>
            <p class="muted small">{t('reader.audio.need', { requests: prep.missing.length })}</p>
            <button class="btn primary block" onClick={() => make(prep.missing)}>{t('reader.audio.make')}</button>
          </>
        ) : (
          <p class="muted small">{t('player.audio.unavailable')}</p>
        )}
        {error && <p class="status error small">{error}</p>}
      </section>
      {textCard(-1)}
      <p class="muted tiny center">{t('reader.tapWordHint')}</p>
      <button class="btn ghost block" onClick={onEdit}>{t('reader.edit')}</button>
    </>
  );
}

function ReaderPlayer({ session, sentences, textCard }: {
  session: ReaderSession;
  sentences: string[];
  textCard: (current: number, onSentence: (i: number) => void, has: Set<number>) => JSX.Element;
}) {
  const { t, settings, update } = useApp();
  const [mode, setMode] = useState<Mode>('continuous');
  const [rate, setRate] = useState(settings.speech.rate);
  const [loop, setLoop] = useState(false);
  const player = useAudioTimeline(session, {
    rate,
    loop,
    stopAfterEach: mode === 'sentence',
    label: (p) => ({ title: sentences[session.order[p]] ?? 'Wordly', artist: t('more.reader') }),
  });
  const has = useMemo(() => new Set(session.order), [session]);
  const current = session.order[player.pos];

  return (
    <>
      {player.playError && <p class="status error small">{t('player.audio.playError')}</p>}
      <div class="segmented reader-mode">
        {(['continuous', 'sentence'] as Mode[]).map((m) => (
          <button key={m} class={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === 'continuous' ? t('reader.continuous') : t('reader.sentence')}
          </button>
        ))}
      </div>
      {textCard(player.playing || mode === 'sentence' || player.pos > 0 ? current : -1, (i) => {
        const p = session.order.indexOf(i);
        if (p >= 0) player.seekTo(p);
      }, has)}
      <p class="muted tiny center">{t('reader.tapHint')}</p>
      <Transport playing={player.playing} onPrev={player.prev} onToggle={player.toggle} onNext={player.next} />
      <SpeedLoop rate={rate} onRate={(r) => { setRate(r); update((s) => ({ speech: { ...s.speech, rate: r } })); }} loop={loop} onLoop={setLoop} />
      <p class="muted tiny center">{t('reader.audio.lockOk')}</p>
    </>
  );
}

function tokens(sentence: string, onWord: (w: string) => void) {
  return sentence.split(WORD).map((part, i) =>
    i % 2 === 1 ? (
      <button key={i} class="tap-word" onClick={(e) => { e.stopPropagation(); onWord(part); }}>{part}</button>
    ) : (
      part
    ),
  );
}

export function Sheet({ onClose, children }: { onClose: () => void; children: ComponentChildren }) {
  const { t } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  // Rendered into <body>: inside the page's scroll area, iOS clips fixed elements to that area,
  // which hid the bottom of the sheet (and its save button) behind the tab bar.
  return createPortal(
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-bar">
          <button class="btn link" onClick={onClose}>{t('reader.close')}</button>
        </div>
        <div class="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
