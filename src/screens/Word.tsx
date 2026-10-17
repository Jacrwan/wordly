import { useEffect, useState } from 'preact/hooks';
import { AiUnavailable, ensureEasyNote } from '../ai/dictionary';
import { Page } from '../components/Layout';
import { viewKo } from '../dict/lookup';
import type { WordView } from '../dict/types';
import { db } from '../db/schema';
import { useLive } from '../hooks/useLive';
import { useWord, type AiState } from '../hooks/useWord';
import { posLabel } from '../i18n/pos';
import { back, go, href } from '../router';
import { pronounce, speak } from '../speech/speak';
import { useApp } from '../state';
import { removeWord, saveWord, setStatus } from '../words';

const FIRST_MEANINGS = 5;

export function WordScreen({ query }: { query: string }) {
  const { t } = useApp();
  const { state, ai, aiError, retry } = useWord(query);

  return (
    <Page title={state.status === 'ready' ? state.view.word : t('word.title')} onBack={() => back('search')}>
      {state.status === 'loading' && <p class="muted center">{t('word.loading')}</p>}
      {state.status === 'aiSearching' && <p class="muted center pulse">{t('word.aiSearching')}</p>}
      {state.status === 'offline' && <p class="muted center">{t('word.offline')}</p>}
      {state.status === 'notFound' && (
        <div class="card center">
          <p>{t('word.notFound', { q: query })}</p>
          {state.suggestion ? (
            <a class="btn" href={href('word', state.suggestion)}>{t('word.didYouMean', { w: state.suggestion })}</a>
          ) : state.aiUnavailable ? (
            <p class="muted small">{t('word.aiUnavailable')}</p>
          ) : state.aiError ? (
            <>
              <p class="muted small">{t('word.aiError')}</p>
              {aiError && <p class="muted tiny">{aiError === 'busy' ? t('word.aiBusy') : aiError}</p>}
              <button class="btn" onClick={retry}>{t('word.retry')}</button>
            </>
          ) : (
            <p class="muted small">{t('word.notFoundAi')}</p>
          )}
        </div>
      )}
      {state.status === 'ready' && <WordCard view={state.view} via={state.via} ai={ai} aiError={aiError} retry={retry} />}
    </Page>
  );
}

function AiTag() {
  const { t } = useApp();
  return <span class="ai-tag" title={t('word.aiTagTitle')} aria-label={t('word.aiTagTitle')}>{t('word.aiTag')}</span>;
}

export function WordCard({ view, via, ai, aiError, retry }: {
  view: WordView;
  via?: string;
  ai: AiState;
  aiError?: string;
  retry: () => void;
}) {
  const { t, settings } = useApp();
  const lang = settings.uiLang;
  const [allMeanings, setAllMeanings] = useState(false);
  const saved = useLive(() => db.myWords.get(view.key), [view.key]);
  const meanings = allMeanings ? view.meanings : view.meanings.slice(0, FIRST_MEANINGS);
  const posList = [...new Set(view.meanings.map((m) => m.p).filter(Boolean))];

  return (
    <article class="word">
      <header class="word-head">
        <div>
          <h2 class="word-title" lang="en">{view.word}</h2>
          <p class="word-sub">
            {view.ipa && <span class="ipa">{view.ipa}</span>}
            {view.ipaAi && <AiTag />}
            {posList.map((p) => <span class="pos" key={p}>{posLabel(p, lang)}</span>)}
          </p>
        </div>
        <button class="btn icon-btn" onClick={() => pronounce(view.word, view.audioUrl)} aria-label={t('word.listen')}>
          <SpeakerIcon />
        </button>
      </header>

      {via && <p class="note">{t('word.via', { via, w: view.word })}</p>}
      {viewKo(view, 4).length > 0 && (
        <p class="word-ko">
          {viewKo(view, 4).map((k, i) => (
            <span key={k}>
              {i > 0 && ' · '}
              {k}
              {view.topKoAi.includes(k) && <AiTag />}
            </span>
          ))}
        </p>
      )}

      <section class="card">
        <h3>{t('word.meanings')}</h3>
        {ai === 'loading' && !view.meanings.some((m) => m.ko.length) && <p class="muted pulse">{t('word.aiLoading')}</p>}
        <ol class="meanings">
          {meanings.map((m, i) => (
            <li key={i}>
              <div class="meaning-ko">
                {m.p && m.p !== meanings[i - 1]?.p && <span class="pos small-pos">{posLabel(m.p, lang)}</span>}
                {m.ko.length ? <strong>{m.ko.join(', ')}</strong> : null}
                {m.ai && <AiTag />}
              </div>
              <div class="meaning-en" lang="en">{m.g}</div>
              {m.ex?.[0] && <div class="meaning-ex" lang="en">{m.ex[0]}</div>}
            </li>
          ))}
        </ol>
        {view.meanings.length > FIRST_MEANINGS && (
          <button class="btn link" onClick={() => setAllMeanings(!allMeanings)}>
            {allMeanings ? t('word.lessMeanings') : t('word.moreMeanings', { n: view.meanings.length - FIRST_MEANINGS })}
          </button>
        )}
        {view.ofWord && view.ofKo && (
          <p class="small">
            <a href={href('word', view.ofWord)}>{t('word.ofKo', { w: view.ofWord })}</a>: {view.ofKo.join(', ')}
          </p>
        )}
        {view.wordKo.length > 0 && <p class="small muted">{t('word.otherKo')}: {view.wordKo.join(', ')}</p>}
      </section>

      {view.synonyms.length > 0 && (
        <section class="card">
          <h3>{t('word.synonyms')} {view.synonymsAi && <AiTag />}</h3>
          <div class="chips">
            {view.synonyms.map((s) => <a key={s} class="chip" href={href('word', s)} lang="en">{s}</a>)}
          </div>
        </section>
      )}

      <section class="card">
        <h3>{t('word.examples')}</h3>
        {ai === 'loading' && <p class="muted pulse">{t('word.aiLoading')}</p>}
        {ai === 'waiting' && <p class="muted pulse">{t('word.aiWaiting')}</p>}
        {ai === 'error' && (
          <p class="muted small">
            {t('word.aiError')} <button class="btn link" onClick={retry}>{t('word.retry')}</button>
            {aiError && <span class="tiny block">{aiError === 'busy' ? t('word.aiBusy') : aiError}</span>}
          </p>
        )}
        {ai === 'unavailable' && <p class="muted small">{t('word.aiUnavailable')}</p>}
        {view.examples.length === 0 && ai === 'idle' && <p class="muted">{t('word.noExamples')}</p>}
        <ul class="examples">
          {view.examples.slice(0, 4).map((x, i) => (
            <li key={i}>
              <button class="example-en" lang="en" onClick={() => speak(x.en, 'en-US', 0.9)} aria-label={t('word.listenSentence')}>
                {x.en}
              </button>
              <div class="example-ko">
                {x.ko} {x.ai && <AiTag />}
                {x.meaning && <span class="example-m">{x.meaning}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {saved && <EasyNote view={view} />}

      <SaveBar view={view} saved={saved} />
    </article>
  );
}

function EasyNote({ view }: { view: WordView }) {
  const { t, settings } = useApp();
  const note = useLive(() => db.easyNotes.get(view.key), [view.key]);
  const [error, setError] = useState<'unavailable' | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Generated once, right after the first save; ensureEasyNote returns the cached note after that.
  useEffect(() => {
    let live = true;
    setError(null);
    ensureEasyNote(view.key, view.word, view.meanings, settings).catch(
      (e) => live && setError(e instanceof AiUnavailable ? 'unavailable' : 'failed'),
    );
    return () => {
      live = false;
    };
  }, [view.key, attempt, settings.familyCode, settings.apiKey]);

  return (
    <section class="card easy">
      <h3>{t('word.easy')} <AiTag /></h3>
      {note ? (
        <p>{note.text}</p>
      ) : error === 'unavailable' ? (
        <p class="muted small">{t('word.easyUnavailable')}</p>
      ) : error === 'failed' ? (
        <p class="muted small">
          {t('word.aiError')}{' '}
          <button class="btn link" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>{t('word.retry')}</button>
        </p>
      ) : (
        <p class="muted pulse">{t('word.easyLoading')}</p>
      )}
    </section>
  );
}

function SaveBar({ view, saved }: { view: WordView; saved: { status: string } | undefined }) {
  const { t } = useApp();
  if (!saved) {
    return (
      <div class="save-bar">
        <button class="btn primary block" onClick={() => saveWord(view, 'search')}>{t('word.save')}</button>
      </div>
    );
  }
  const archived = saved.status === 'archived';
  return (
    <div class="save-bar">
      <p class={`status ${archived ? '' : 'ok'}`}>{archived ? t('word.archived') : `✓ ${t('word.saved')}`}</p>
      <div class="row">
        <button class="btn ghost" onClick={() => setStatus(view.key, archived ? 'learning' : 'archived')}>
          {archived ? t('word.unarchive') : t('word.archive')}
        </button>
        <button class="btn ghost danger" onClick={async () => {
          if (confirm(t('word.removeConfirm', { w: view.word }))) {
            await removeWord(view.key);
            go('words');
          }
        }}>
          {t('word.remove')}
        </button>
      </div>
    </div>
  );
}

function SpeakerIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}
