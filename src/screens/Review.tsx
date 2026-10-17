import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Layout';
import { buildView, findEntry } from '../dict/lookup';
import { cachedFill } from '../ai/dictionary';
import type { WordView } from '../dict/types';
import { db, type CardRow, type MyWord } from '../db/schema';
import { viewKo } from '../dict/lookup';
import { refreshSnapshot } from '../words';
import { useLive } from '../hooks/useLive';
import { href } from '../router';
import { pronounce } from '../speech/speak';
import { nextCard, preview, queueStats, rate, Rating, type Grade, type QueueStats } from '../srs';
import { useApp } from '../state';

type Phase = 'start' | 'card' | 'done';

export function Review() {
  const { t, settings } = useApp();
  const daily = settings.dailyNewCards;
  const [phase, setPhase] = useState<Phase>('start');
  const [ahead, setAhead] = useState(false);
  const [card, setCard] = useState<CardRow | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const stats = useLive(() => queueStats(daily), [daily, reviewed]);
  const mastered = useLive(() => db.myWords.where('status').equals('mastered').count(), [reviewed]);
  const wordCount = useLive(() => db.myWords.count(), []);

  async function advance(last?: string, early = ahead) {
    const next = await nextCard(daily, last, early);
    setCard(next);
    setPhase(next ? 'card' : 'done');
  }

  async function answer(grade: Grade) {
    if (!card) return;
    await rate(card.word, card.dir, grade);
    setReviewed((n) => n + 1);
    await advance(card.word);
  }

  if (phase === 'card' && card) {
    return (
      <Page title={t('review.title')}>
        <ReviewCard key={`${card.word}/${card.dir}/${reviewed}`} row={card} stats={stats} onAnswer={answer} />
      </Page>
    );
  }

  return (
    <Page title={t('review.title')}>
      {phase === 'done' ? (
        <section class="card center">
          <h2>{t('review.doneTitle')}</h2>
          <p>{t('review.doneCount', { n: reviewed })}</p>
          {mastered !== undefined && <p class="muted">{t('review.mastered', { n: mastered })}</p>}
          <button class="btn block" onClick={() => { setPhase('start'); setAhead(false); }}>{t('review.finish')}</button>
        </section>
      ) : wordCount === 0 ? (
        <p class="muted center">{t('review.noWords')}</p>
      ) : stats ? (
        <StartPanel stats={stats} onStart={(early) => { setAhead(early); setReviewed(0); advance(undefined, early); }} />
      ) : null}
    </Page>
  );
}

function StartPanel({ stats, onStart }: { stats: QueueStats; onStart: (ahead: boolean) => void }) {
  const { t, settings } = useApp();
  const total = stats.due + stats.fresh + stats.learning;
  const when = stats.nextDue?.toLocaleString(settings.uiLang === 'ko' ? 'ko-KR' : 'en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return (
    <section class="card">
      <div class="stat-row">
        <div class="stat"><strong>{stats.due + stats.learning}</strong><span>{t('review.dueNow')}</span></div>
        <div class="stat"><strong>{stats.fresh}</strong><span>{t('review.newToday')}</span></div>
      </div>
      {total > 0 ? (
        <button class="btn primary block" onClick={() => onStart(false)}>{t('review.start')}</button>
      ) : (
        <>
          <p class="center">{t('review.nothing')}</p>
          {when && <p class="muted center small">{t('review.nextAt', { when })}</p>}
          {stats.nextDue && (
            <>
              <button class="btn block" onClick={() => onStart(true)}>{t('review.ahead')}</button>
              <p class="muted small center">{t('review.aheadHelp')}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function ReviewCard({ row, stats, onAnswer }: { row: CardRow; stats?: QueueStats; onAnswer: (g: Grade) => void }) {
  const { t, settings } = useApp();
  const [shown, setShown] = useState(false);
  const [hint, setHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<WordView | null>(null);
  const word = useLive(() => db.myWords.get(row.word), [row.word]) as MyWord | undefined;
  const intervals = preview(row, settings.uiLang);

  // Word details (IPA, audio, an example) come from the offline dictionary; never calls AI.
  useEffect(() => {
    let live = true;
    (async () => {
      const found = await findEntry(row.word);
      const entry = found.kind === 'found' ? found.entry : null;
      const v = buildView(row.word, entry, await cachedFill(row.word));
      if (v) refreshSnapshot(v);
      if (live) setView(v);
    })();
    return () => {
      live = false;
    };
  }, [row.word]);

  const display = word?.display ?? view?.word ?? row.word;
  // Current dictionary order (most common meaning first); the saved snapshot only as a fallback.
  const ko = (view ? viewKo(view) : word?.ko ?? []).join(', ');
  const example = view?.examples[0];
  const en2ko = row.dir === 'en2ko';
  const left = stats ? stats.due + stats.fresh + stats.learning : 0;

  function reveal() {
    setShown(true);
    if (!en2ko) pronounce(display, view?.audioUrl); // recall: hear the answer
  }

  async function choose(g: Grade) {
    if (busy) return;
    setBusy(true);
    await onAnswer(g);
  }

  const buttons: { g: Grade; label: string; cls: string }[] = [
    { g: Rating.Again, label: t('review.again'), cls: 'again' },
    { g: Rating.Hard, label: t('review.hard'), cls: 'hard' },
    { g: Rating.Good, label: t('review.good'), cls: 'good' },
    { g: Rating.Easy, label: t('review.easy'), cls: 'easy' },
  ];

  return (
    <div class="review">
      <p class="muted small review-meta">
        <span>{en2ko ? t('review.en2ko') : t('review.ko2en')}</span>
        {left > 0 && <span>{t('review.left', { n: left })}</span>}
      </p>

      <section class="card review-card">
        {en2ko ? (
          <>
            <h2 class="review-word" lang="en">{display}</h2>
            {view?.ipa && <p class="ipa center">{view.ipa}</p>}
            <button class="btn icon-btn center-btn" onClick={() => pronounce(display, view?.audioUrl)} aria-label={t('word.listen')}>🔊</button>
          </>
        ) : (
          <>
            <h2 class="review-ko">{ko}</h2>
            {!shown && (
              hint ? (
                <p class="muted center">{t('review.hintText', { first: display[0], n: display.replace(/\s/g, '').length })}</p>
              ) : (
                <button class="btn link center-btn" onClick={() => setHint(true)}>{t('review.hint')}</button>
              )
            )}
          </>
        )}

        {shown && (
          <div class="answer">
            {en2ko ? (
              <p class="review-ko">{ko}</p>
            ) : (
              <>
                <p class="review-word" lang="en">{display}</p>
                {view?.ipa && <p class="ipa center">{view.ipa}</p>}
              </>
            )}
            {example && (
              <div class="review-example">
                <div lang="en">{example.en}</div>
                <div class="muted">{example.ko}</div>
              </div>
            )}
            <a class="small" href={href('word', row.word)}>{t('review.openCard')}</a>
          </div>
        )}
      </section>

      {shown ? (
        <div class="grades">
          {buttons.map((b) => (
            <button key={b.g} class={`grade ${b.cls}`} disabled={busy} onClick={() => choose(b.g)}>
              <span class="grade-label">{b.label}</span>
              <span class="grade-ivl">{intervals[b.g]}</span>
            </button>
          ))}
        </div>
      ) : (
        <button class="btn primary block big-btn" onClick={reveal}>{t('review.show')}</button>
      )}
    </div>
  );
}
