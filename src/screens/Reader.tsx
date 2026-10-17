import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Page } from '../components/Layout';
import { SpeechQueue, type Lang, type QueueState, type Segment } from '../speech/engine';
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

const langOf = (s: string): Lang => ((s.match(/[가-힣]/g)?.length ?? 0) > s.length * 0.3 ? 'ko-KR' : 'en-US');
const WORD = /([A-Za-z]+(?:['’-][A-Za-z]+)*)/;

type Mode = 'continuous' | 'sentence';

export function Reader() {
  const { t, settings, update } = useApp();
  const [text, setText] = useState(loadDraft);
  const [editing, setEditing] = useState(() => !loadDraft());
  const [mode, setMode] = useState<Mode>('continuous');
  const [rate, setRate] = useState(settings.speech.rate);
  const [loop, setLoop] = useState(false);
  const [lookup, setLookup] = useState<string | null>(null);
  const queue = useMemo(() => new SpeechQueue(), []);
  const [st, setSt] = useState<QueueState>(queue.state);
  const sentences = useMemo(() => splitSentences(text), [text]);

  useEffect(() => {
    queue.onChange = setSt;
    return () => queue.stop();
  }, []);

  useEffect(() => {
    if (editing) return queue.stop();
    const segs: Segment[] = [];
    sentences.forEach((s, g) => {
      segs.push({ kind: 'say', text: s.text, lang: langOf(s.text), group: g });
      segs.push({ kind: 'pause', ms: s.paragraphStart && g > 0 ? 500 : 250, group: g });
    });
    queue.load(segs);
  }, [sentences, editing]);

  useEffect(() => {
    queue.rate = rate;
    queue.loop = loop;
    queue.stopAfterGroup = mode === 'sentence';
  }, [rate, loop, mode]);

  function openWord(w: string) {
    queue.pause();
    setLookup(w.replace(/[’]/g, "'"));
  }

  function done() {
    saveDraft(text);
    setEditing(false);
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
        <>
          <div class="segmented reader-mode">
            {(['continuous', 'sentence'] as Mode[]).map((m) => (
              <button key={m} class={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === 'continuous' ? t('reader.continuous') : t('reader.sentence')}
              </button>
            ))}
          </div>

          <section class="card reader-text" lang="en">
            {sentences.map((s, i) => (
              <Fragment key={i}>
                {s.paragraphStart && i > 0 && <br />}
                {/* Tapping a sentence (not a word) moves playback there. */}
                <span class={`sentence ${i === st.group && (st.playing || mode === 'sentence') ? 'current' : ''}`}
                  onClick={() => queue.jumpToGroup(i)}>
                  {tokens(s.text, openWord)}{' '}
                </span>
              </Fragment>
            ))}
          </section>
          <p class="muted tiny center">{t('reader.tapHint')}</p>

          <Transport playing={st.playing} onPrev={() => queue.prevGroup()} onToggle={() => queue.toggle()} onNext={() => queue.nextGroup()} />
          <SpeedLoop rate={rate} onRate={(r) => { setRate(r); update((s) => ({ speech: { ...s.speech, rate: r } })); }} loop={loop} onLoop={setLoop} />
          <button class="btn ghost block" onClick={() => { queue.stop(); setEditing(true); }}>{t('reader.edit')}</button>
        </>
      )}

      {lookup && (
        <Sheet onClose={() => setLookup(null)}>
          <WordPanel query={lookup} source="reader" />
        </Sheet>
      )}
    </Page>
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
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-bar">
          <button class="btn link" onClick={onClose}>{t('reader.close')}</button>
        </div>
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}
