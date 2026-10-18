import { useEffect, useRef, useState } from 'preact/hooks';
import { cachedFill } from '../ai/dictionary';
import { connFrom } from '../ai/gemini';
import { ttsModels } from '../ai/tts';
import { Page } from '../components/Layout';
import { buildView, findEntry, viewKo } from '../dict/lookup';
import { db, type WordStatus } from '../db/schema';
import { useAudioTimeline } from '../hooks/useAudioTimeline';
import type { StringKey } from '../i18n';
import { batches, buildSession, cachedClips, makeClips, type ClipItem, type Session } from '../speech/clips';
import { useApp } from '../state';

// Hands-free listening: each saved word is read as word → Korean meaning → definition →
// synonyms from Gemini TTS clips cached per word (speech/clips.ts), played as one audio file so
// it keeps going with the screen locked or the app in the background. Listening never changes
// review scheduling (only active recall does).

type Source = 'all' | 'learning' | 'due' | 'mastered';
const SOURCES: Source[] = ['all', 'learning', 'due', 'mastered'];

type Item = ClipItem;

async function loadItems(source: Source): Promise<Item[]> {
  let words = (await db.myWords.orderBy('addedAt').reverse().toArray()).filter((w) => w.status !== 'archived');
  if (source === 'learning' || source === 'mastered') words = words.filter((w) => w.status === (source as WordStatus));
  if (source === 'due') {
    const now = Date.now();
    const due = new Set((await db.cards.where('due').belowOrEqual(new Date(now)).toArray()).map((c) => c.word));
    words = words.filter((w) => due.has(w.word));
  }
  const items = await Promise.all(
    words.map(async (w) => {
      const found = await findEntry(w.word);
      const view = buildView(w.word, found.kind === 'found' ? found.entry : null, await cachedFill(w.word));
      const gloss = view?.meanings.find((m) => m.ko.length)?.g ?? view?.meanings[0]?.g ?? '';
      return {
        key: w.word,
        word: view?.word ?? w.display,
        ko: view ? viewKo(view, 3) : w.ko,
        definition: shorten(gloss),
        synonyms: view?.synonyms.slice(0, 3) ?? [],
      };
    }),
  );
  return items;
}

/** First clause of a definition, so each word stays short to listen to. */
function shorten(gloss: string): string {
  const first = gloss.split(/;|\(|—/)[0].trim().replace(/[.:,]$/, '');
  return first.length > 120 ? first.slice(0, 117).replace(/\s+\S*$/, '') + '…' : first;
}

export function Player() {
  const { t, settings, update } = useApp();
  const [source, setSource] = useState<Source>('all');
  const [items, setItems] = useState<Item[] | null>(null);
  const [rate, setRate] = useState(settings.speech.rate);
  const [loop, setLoop] = useState(false);

  useEffect(() => {
    let live = true;
    setItems(null);
    loadItems(source).then((list) => live && setItems(list));
    return () => {
      live = false;
    };
  }, [source]);

  const saveRate = (r: number) => {
    setRate(r);
    update((s) => ({ speech: { ...s.speech, rate: r } }));
  };

  return (
    <Page title={t('more.player')} back="more">
      <div class="chips filter-chips">
        {SOURCES.map((s) => (
          <button key={s} class={`chip ${source === s ? 'on' : ''}`} aria-pressed={source === s} onClick={() => setSource(s)}>
            {t(`player.src.${s}` as StringKey)}
          </button>
        ))}
      </div>

      {items === null ? (
        <p class="muted center">{t('word.loading')}</p>
      ) : items.length === 0 ? (
        <p class="muted center">{t('player.empty')}</p>
      ) : (
        <AudioPlayer key={source} items={items} rate={rate} onRate={saveRate} loop={loop} onLoop={setLoop} />
      )}
    </Page>
  );
}

interface PlayerProps {
  items: Item[];
  rate: number;
  onRate: (r: number) => void;
  loop: boolean;
  onLoop: (l: boolean) => void;
}

type Prep =
  | { phase: 'checking' }
  | { phase: 'need'; missing: Item[]; ready: number }
  | { phase: 'making'; done: number; total: number; waitMs?: number }
  | { phase: 'ready'; session: Session; partial: boolean };

/** Gemini TTS clips joined into one audio file: keeps playing with the screen locked. */
function AudioPlayer({ items, rate, onRate, loop, onLoop }: PlayerProps) {
  const { t, settings } = useApp();
  const [prep, setPrep] = useState<Prep>({ phase: 'checking' });
  const [error, setError] = useState('');
  const conn = connFrom(settings);
  const models = ttsModels(settings);
  const canMake = !!conn && models.length > 0;
  const cancel = useRef<AbortController | null>(null);
  const alive = useRef(true);

  // Cached clips for this list; plays right away when every word has one.
  const check = async (playPartial = false) => {
    const clips = await cachedClips(items);
    if (!alive.current) return;
    const missing = items.filter((it) => !clips.has(it.key));
    const session = buildSession(items, clips);
    if (session && (!missing.length || playPartial)) setPrep({ phase: 'ready', session, partial: missing.length > 0 });
    else setPrep({ phase: 'need', missing, ready: clips.size });
  };

  useEffect(() => {
    alive.current = true;
    setPrep({ phase: 'checking' });
    setError('');
    check().catch(() => alive.current && setError(t('player.audio.error')));
    return () => { alive.current = false; cancel.current?.abort(); };
  }, [items]);

  const make = async (missing: Item[]) => {
    if (!conn || !models.length) return;
    const ctl = new AbortController();
    cancel.current = ctl;
    setError('');
    setPrep({ phase: 'making', done: 0, total: missing.length });
    const res = await makeClips(conn, models, missing, (p) => setPrep({ phase: 'making', ...p }), ctl.signal);
    if (ctl.signal.aborted) return;
    if (res.stopped === 'quota') setError(t((await cachedClips(items)).size ? 'player.audio.quota' : 'player.audio.quotaNone'));
    if (res.stopped === 'error') {
      console.warn('word clips failed', res.error);
      setError(t('player.audio.error'));
    }
    check(res.stopped !== 'error');
  };

  if (prep.phase === 'ready') {
    return (
      <>
        {error && <p class="status error small">{error}</p>}
        <SessionPlayer key={prep.session.audio.size} items={items} session={prep.session} rate={rate} onRate={onRate} loop={loop} onLoop={onLoop} />
        {prep.partial && canMake && (
          <button class="btn ghost block" onClick={() => check()}>{t('player.audio.makeRest')}</button>
        )}
      </>
    );
  }

  return (
    <section class="card audio-prep">
      {prep.phase === 'checking' ? (
        <p class="muted center">{t('word.loading')}</p>
      ) : prep.phase === 'making' ? (
        <>
          <progress class="progress" max={prep.total} value={prep.done} />
          <p class="small">{t('player.audio.making', { done: prep.done, total: prep.total })}</p>
          <p class="muted tiny">{prep.waitMs ? t('player.audio.waiting', { s: Math.ceil(prep.waitMs / 1000) }) : t('player.audio.keepOpen')}</p>
          <button class="btn ghost block" onClick={() => { cancel.current?.abort(); check(); }}>{t('player.audio.stop')}</button>
        </>
      ) : (
        <>
          <p>{t('player.audio.need', { n: prep.missing.length })}</p>
          {canMake ? (
            <>
              <p class="muted small">{t('player.audio.needHelp', { requests: batches(prep.missing).length })}</p>
              <button class="btn primary block" onClick={() => make(prep.missing)}>{t('player.audio.make', { n: prep.missing.length })}</button>
            </>
          ) : (
            <p class="muted small">{t('player.audio.unavailable')}</p>
          )}
          {prep.ready > 0 && (
            <button class="btn block gap-top" onClick={() => check(true)}>{t('player.audio.playReady', { n: prep.ready })}</button>
          )}
        </>
      )}
      {error && <p class="status error small">{error}</p>}
    </section>
  );
}

function SessionPlayer({ items, session, rate, onRate, loop, onLoop }: PlayerProps & { session: Session }) {
  const { t } = useApp();
  const player = useAudioTimeline(session, {
    rate,
    loop,
    label: (p) => ({ title: items[session.order[p]]?.word ?? 'Wordly', artist: items[session.order[p]]?.ko.join(', ') }),
  });
  const index = session.order[player.pos];
  const has = new Set(session.order);
  return (
    <>
      {player.playError && <p class="status error small">{t('player.audio.playError')}</p>}
      <NowPlaying items={items} index={index} position={{ n: player.pos + 1, total: session.order.length }} />
      <Transport playing={player.playing} onPrev={player.prev} onToggle={player.toggle} onNext={player.next} />
      <SpeedLoop rate={rate} onRate={onRate} loop={loop} onLoop={onLoop} />
      <p class="muted tiny center">{t('player.audio.lockOk')}</p>
      <Playlist items={items} current={index} onPick={(i) => {
        const p = session.order.indexOf(i);
        if (p >= 0) player.seekTo(p);
      }} disabled={(i) => !has.has(i)} />
    </>
  );
}

function NowPlaying({ items, index, position }: { items: Item[]; index: number; position: { n: number; total: number } }) {
  const { t } = useApp();
  const current = items[index];
  return (
    <section class="card now-playing">
      <p class="muted small">{t('player.position', position)}</p>
      {current && (
        <>
          <h2 class="np-word" lang="en">{current.word}</h2>
          <p class="np-ko">{current.ko.join(', ')}</p>
          <p class="np-def" lang="en">{current.definition}</p>
          {current.synonyms.length > 0 && (
            <p class="np-syn" lang="en">≈ {current.synonyms.join(', ')}</p>
          )}
        </>
      )}
    </section>
  );
}

function Playlist({ items, current, onPick, disabled }: { items: Item[]; current: number; onPick: (i: number) => void; disabled?: (i: number) => boolean }) {
  return (
    <ul class="list word-list playlist">
      {items.map((it, i) => (
        <li key={it.key} class={i === current ? 'current' : ''}>
          <button class="pl-row" onClick={() => onPick(i)} disabled={disabled?.(i)}>
            <span class="wl-main">
              <span class="wl-word" lang="en">{it.word}</span>
              <span class="wl-ko">{it.ko.join(', ')}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Transport({ playing, onPrev, onToggle, onNext }: { playing: boolean; onPrev: () => void; onToggle: () => void; onNext: () => void }) {
  const { t } = useApp();
  return (
    <div class="transport">
      <button class="btn icon-btn" onClick={onPrev} aria-label={t('player.prev')}>⏮</button>
      <button class="btn primary play-btn" onClick={onToggle} aria-label={playing ? t('player.pause') : t('player.play')}>
        {playing ? '⏸' : '▶'}
      </button>
      <button class="btn icon-btn" onClick={onNext} aria-label={t('player.next')}>⏭</button>
    </div>
  );
}

export function SpeedLoop({ rate, onRate, loop, onLoop, hideLoop }: {
  rate: number;
  onRate: (r: number) => void;
  loop: boolean;
  onLoop: (l: boolean) => void;
  hideLoop?: boolean;
}) {
  const { t } = useApp();
  return (
    <div class="speed-loop">
      <label class="speed">
        <span>{t('player.speed')} <strong>{rate.toFixed(1)}×</strong></span>
        <input type="range" min="0.5" max="1.5" step="0.1" value={rate}
          onInput={(e) => onRate(Number(e.currentTarget.value))} aria-label={t('player.speed')} />
      </label>
      {!hideLoop && <button class={`chip ${loop ? 'on' : ''}`} aria-pressed={loop} onClick={() => onLoop(!loop)}>🔁 {t('player.loop')}</button>}
    </div>
  );
}
