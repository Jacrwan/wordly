import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cachedFill } from '../ai/dictionary';
import { connFrom } from '../ai/gemini';
import { ttsModels } from '../ai/tts';
import { Page } from '../components/Layout';
import { buildView, findEntry, viewKo } from '../dict/lookup';
import { db, type WordStatus } from '../db/schema';
import type { StringKey } from '../i18n';
import { buildSession, cachedClips, makeClips, type ClipItem, type Session } from '../speech/clips';
import { setMediaSession, SpeechQueue, type QueueState, type Segment } from '../speech/engine';
import { useApp } from '../state';

// Hands-free listening: each saved word is read as word → Korean meaning → definition →
// synonyms, either by the device's voices (Web Speech) or, in lock-screen mode, from Gemini
// TTS clips cached per word (speech/clips.ts). Listening never changes review scheduling
// (only active recall does).

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

function segments(items: Item[]): Segment[] {
  const out: Segment[] = [];
  items.forEach((it, g) => {
    out.push({ kind: 'say', text: it.word, lang: 'en-US', group: g, part: 'word' });
    out.push({ kind: 'pause', ms: 500, group: g });
    if (it.ko.length) out.push({ kind: 'say', text: it.ko.join(', '), lang: 'ko-KR', group: g, part: 'ko' });
    out.push({ kind: 'pause', ms: 350, group: g });
    if (it.definition) out.push({ kind: 'say', text: it.definition, lang: 'en-US', group: g, part: 'definition' });
    if (it.synonyms.length) {
      out.push({ kind: 'pause', ms: 350, group: g });
      out.push({ kind: 'say', text: `Similar words: ${it.synonyms.join(', ')}.`, lang: 'en-US', group: g, part: 'synonyms' });
    }
    out.push({ kind: 'pause', ms: 1000, group: g });
  });
  return out;
}

type Mode = 'speech' | 'audio';
const MODE_KEY = 'wordly.playerMode';

function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'audio' ? 'audio' : 'speech';
  } catch {
    return 'speech';
  }
}

export function Player() {
  const { t, settings, update } = useApp();
  const [source, setSource] = useState<Source>('all');
  const [items, setItems] = useState<Item[] | null>(null);
  const [mode, setModeState] = useState<Mode>(savedMode);
  const [notice, setNotice] = useState('');
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

  const setMode = (m: Mode) => {
    setModeState(m);
    setNotice('');
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };

  const saveRate = (r: number) => {
    setRate(r);
    update((s) => ({ speech: { ...s.speech, rate: r } }));
  };

  return (
    <Page title={t('more.player')} back="more">
      <div class="segmented player-mode">
        {(['speech', 'audio'] as Mode[]).map((m) => (
          <button key={m} class={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {t(`player.mode.${m}` as StringKey)}
          </button>
        ))}
      </div>
      <div class="chips filter-chips">
        {SOURCES.map((s) => (
          <button key={s} class={`chip ${source === s ? 'on' : ''}`} aria-pressed={source === s} onClick={() => setSource(s)}>
            {t(`player.src.${s}` as StringKey)}
          </button>
        ))}
      </div>
      {notice && <p class="status error small">{notice}</p>}

      {items === null ? (
        <p class="muted center">{t('word.loading')}</p>
      ) : items.length === 0 ? (
        <p class="muted center">{t('player.empty')}</p>
      ) : mode === 'audio' ? (
        <AudioPlayer items={items} rate={rate} onRate={saveRate} loop={loop} onLoop={setLoop}
          onFallback={(msg) => {
            setMode('speech');
            setNotice(msg);
          }} />
      ) : (
        <SpeechPlayer items={items} rate={rate} onRate={saveRate} loop={loop} onLoop={setLoop} />
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

/** Web Speech: device voices, nothing to download, but stops when the screen locks. */
function SpeechPlayer({ items, rate, onRate, loop, onLoop }: PlayerProps) {
  const { t } = useApp();
  const queue = useMemo(() => new SpeechQueue(), []);
  const [st, setSt] = useState<QueueState>(queue.state);

  useEffect(() => {
    queue.onChange = setSt;
    return () => queue.stop();
  }, []);
  useEffect(() => {
    queue.load(segments(items));
  }, [items]);
  useEffect(() => {
    queue.rate = rate;
  }, [rate]);
  useEffect(() => {
    queue.loop = loop;
  }, [loop]);

  const current = items[st.group];
  useEffect(() => {
    if (current) {
      setMediaSession(current.word, {
        play: () => queue.play(),
        pause: () => queue.pause(),
        next: () => queue.nextGroup(),
        prev: () => queue.prevGroup(),
      });
    }
  }, [current?.key]);

  return (
    <>
      <NowPlaying items={items} index={st.group} part={st.part} />
      <Transport playing={st.playing} onPrev={() => queue.prevGroup()} onToggle={() => queue.toggle()} onNext={() => queue.nextGroup()} />
      <SpeedLoop rate={rate} onRate={onRate} loop={loop} onLoop={onLoop} />
      <p class="muted tiny center">{t('player.lockNote')}</p>
      <Playlist items={items} current={st.group} onPick={(i) => queue.jumpToGroup(i)} />
    </>
  );
}

type Prep =
  | { phase: 'checking' }
  | { phase: 'need'; missing: Item[]; ready: number }
  | { phase: 'making'; done: number; total: number; waitMs?: number }
  | { phase: 'ready'; session: Session; partial: boolean };

/** Gemini TTS clips joined into one audio file: keeps playing with the screen locked. */
function AudioPlayer({ items, rate, onRate, loop, onLoop, onFallback }: PlayerProps & { onFallback: (msg: string) => void }) {
  const { t, settings } = useApp();
  const [prep, setPrep] = useState<Prep>({ phase: 'checking' });
  const [error, setError] = useState('');
  const conn = connFrom(settings);
  const models = ttsModels(settings);
  const cancel = useRef<AbortController | null>(null);

  // Cached clips for this list; plays right away when every word has one.
  const check = async (playPartial = false) => {
    const clips = await cachedClips(items);
    const missing = items.filter((it) => !clips.has(it.key));
    const session = buildSession(items, clips);
    if (session && (!missing.length || playPartial)) setPrep({ phase: 'ready', session, partial: missing.length > 0 });
    else setPrep({ phase: 'need', missing, ready: clips.size });
  };

  useEffect(() => {
    setPrep({ phase: 'checking' });
    setError('');
    check();
    return () => cancel.current?.abort();
  }, [items]);

  const make = async (missing: Item[]) => {
    if (!conn || !models.length) return;
    const ctl = new AbortController();
    cancel.current = ctl;
    setError('');
    setPrep({ phase: 'making', done: 0, total: missing.length });
    const res = await makeClips(conn, models, missing, (p) => setPrep({ phase: 'making', ...p }), ctl.signal);
    if (ctl.signal.aborted) return;
    if (res.stopped === 'quota') {
      const clips = await cachedClips(items);
      // Nothing to play yet: the device voices take over (they stop when the screen locks).
      if (!clips.size) return onFallback(t('player.audio.quotaFallback'));
      setError(t('player.audio.quota'));
      return check(true);
    }
    if (res.stopped === 'error') {
      console.warn('word clips failed', res.error);
      setError(t('player.audio.error'));
    }
    check(res.stopped !== 'error');
  };

  if (!conn || !models.length) {
    return (
      <section class="card center">
        <p>{t('player.audio.unavailable')}</p>
        <button class="btn block" onClick={() => onFallback('')}>{t('player.audio.useDevice')}</button>
      </section>
    );
  }

  if (prep.phase === 'ready') {
    return (
      <>
        {error && <p class="status error small">{error}</p>}
        <SessionPlayer key={prep.session.audio.size} items={items} session={prep.session} rate={rate} onRate={onRate} loop={loop} onLoop={onLoop} />
        {prep.partial && (
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
          <p class="muted small">{t('player.audio.needHelp', { requests: Math.ceil(prep.missing.length / 8) })}</p>
          <button class="btn primary block" onClick={() => make(prep.missing)}>{t('player.audio.make', { n: prep.missing.length })}</button>
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
  const el = useMemo(() => new Audio(), []);
  const [pos, setPos] = useState(0); // index into session.order
  const [playing, setPlaying] = useState(false);
  const posRef = useRef(0);

  const posAt = (time: number) => {
    let i = 0;
    while (i + 1 < session.starts.length && time >= session.starts[i + 1] - 0.05) i++;
    return i;
  };
  const seekTo = (p: number) => {
    const n = session.order.length;
    const next = loop ? (p + n) % n : Math.max(0, Math.min(n - 1, p));
    el.currentTime = next === 0 ? 0 : session.starts[next] - 0.2;
    posRef.current = next;
    setPos(next);
  };
  const prev = () => {
    const p = posAt(el.currentTime);
    // Mid-word: restart this word; near its start: go to the previous one.
    seekTo(el.currentTime - session.starts[p] > 1.5 ? p : p - 1);
  };
  const next = () => seekTo(posAt(el.currentTime) + 1);
  const toggle = () => (el.paused ? el.play().catch(() => {}) : el.pause());

  useEffect(() => {
    const url = URL.createObjectURL(session.audio);
    el.src = url;
    el.preload = 'auto';
    el.ontimeupdate = () => {
      const p = posAt(el.currentTime);
      if (p !== posRef.current) {
        posRef.current = p;
        setPos(p);
      }
    };
    el.onplay = () => setPlaying(true);
    el.onpause = el.onended = () => setPlaying(false);
    // Rate resets when a new file loads in some browsers.
    el.onloadedmetadata = () => (el.playbackRate = rate);
    return () => {
      el.pause();
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
    };
  }, [session]);

  useEffect(() => {
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    el.loop = loop;
  }, [loop]);

  const index = session.order[pos];
  const current = items[index];
  useEffect(() => {
    if (current) {
      setMediaSession(current.word, { play: () => el.play(), pause: () => el.pause(), next, prev }, current.ko.join(', '));
    }
  }, [current?.key, loop]);

  const has = new Set(session.order);
  return (
    <>
      <NowPlaying items={items} index={index} position={{ n: pos + 1, total: session.order.length }} />
      <Transport playing={playing} onPrev={prev} onToggle={toggle} onNext={next} />
      <SpeedLoop rate={rate} onRate={onRate} loop={loop} onLoop={onLoop} />
      <p class="muted tiny center">{t('player.audio.lockOk')}</p>
      <Playlist items={items} current={index} onPick={(i) => {
        const p = session.order.indexOf(i);
        if (p >= 0) seekTo(p);
      }} disabled={(i) => !has.has(i)} />
    </>
  );
}

function NowPlaying({ items, index, part, position }: { items: Item[]; index: number; part?: string; position?: { n: number; total: number } }) {
  const { t } = useApp();
  const current = items[index];
  return (
    <section class="card now-playing">
      <p class="muted small">{t('player.position', position ?? { n: index + 1, total: items.length })}</p>
      {current && (
        <>
          <h2 class={`np-word ${part === 'word' ? 'speaking' : ''}`} lang="en">{current.word}</h2>
          <p class={`np-ko ${part === 'ko' ? 'speaking' : ''}`}>{current.ko.join(', ')}</p>
          <p class={`np-def ${part === 'definition' ? 'speaking' : ''}`} lang="en">{current.definition}</p>
          {current.synonyms.length > 0 && (
            <p class={`np-syn ${part === 'synonyms' ? 'speaking' : ''}`} lang="en">≈ {current.synonyms.join(', ')}</p>
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
