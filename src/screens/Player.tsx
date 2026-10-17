import { useEffect, useMemo, useState } from 'preact/hooks';
import { cachedFill } from '../ai/dictionary';
import { Page } from '../components/Layout';
import { buildView, findEntry, viewKo } from '../dict/lookup';
import { db, type WordStatus } from '../db/schema';
import type { StringKey } from '../i18n';
import { setMediaSession, SpeechQueue, type QueueState, type Segment } from '../speech/engine';
import { useApp } from '../state';

// Hands-free listening: each saved word is read as word → Korean meaning → definition →
// synonyms. Listening never changes review scheduling (only active recall does).

type Source = 'all' | 'learning' | 'due' | 'mastered';
const SOURCES: Source[] = ['all', 'learning', 'due', 'mastered'];

interface Item {
  key: string;
  word: string;
  ko: string[];
  definition: string;
  synonyms: string[];
}

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

export function Player() {
  const { t, settings, update } = useApp();
  const [source, setSource] = useState<Source>('all');
  const [items, setItems] = useState<Item[] | null>(null);
  const queue = useMemo(() => new SpeechQueue(), []);
  const [st, setSt] = useState<QueueState>(queue.state);
  const [rate, setRate] = useState(settings.speech.rate);
  const [loop, setLoop] = useState(false);

  useEffect(() => {
    queue.onChange = setSt;
    return () => queue.stop();
  }, []);

  useEffect(() => {
    let live = true;
    setItems(null);
    loadItems(source).then((list) => {
      if (!live) return;
      setItems(list);
      queue.load(segments(list));
    });
    return () => {
      live = false;
    };
  }, [source]);

  useEffect(() => {
    queue.rate = rate;
  }, [rate]);
  useEffect(() => {
    queue.loop = loop;
  }, [loop]);

  const current = items?.[st.group];
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
        <>
          <section class="card now-playing">
            <p class="muted small">{t('player.position', { n: st.group + 1, total: items.length })}</p>
            {current && (
              <>
                <h2 class={`np-word ${st.part === 'word' ? 'speaking' : ''}`} lang="en">{current.word}</h2>
                <p class={`np-ko ${st.part === 'ko' ? 'speaking' : ''}`}>{current.ko.join(', ')}</p>
                <p class={`np-def ${st.part === 'definition' ? 'speaking' : ''}`} lang="en">{current.definition}</p>
                {current.synonyms.length > 0 && (
                  <p class={`np-syn ${st.part === 'synonyms' ? 'speaking' : ''}`} lang="en">≈ {current.synonyms.join(', ')}</p>
                )}
              </>
            )}
          </section>

          <Transport playing={st.playing} onPrev={() => queue.prevGroup()} onToggle={() => queue.toggle()} onNext={() => queue.nextGroup()} />
          <SpeedLoop rate={rate} onRate={saveRate} loop={loop} onLoop={setLoop} />
          <p class="muted tiny center">{t('player.lockNote')}</p>

          <ul class="list word-list playlist">
            {items.map((it, i) => (
              <li key={it.key} class={i === st.group ? 'current' : ''}>
                <button class="pl-row" onClick={() => queue.jumpToGroup(i)}>
                  <span class="wl-main">
                    <span class="wl-word" lang="en">{it.word}</span>
                    <span class="wl-ko">{it.ko.join(', ')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
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
