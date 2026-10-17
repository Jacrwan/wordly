import { useEffect, useRef, useState } from 'preact/hooks';
import { Page } from '../components/Layout';
import { isKorean, koSearch, suggest, type Suggestion } from '../dict/lookup';
import { db } from '../db/schema';
import { useLive } from '../hooks/useLive';
import { go, href } from '../router';
import { useApp } from '../state';

type Results = { kind: 'none' } | { kind: 'en'; items: Suggestion[] } | { kind: 'ko'; q: string; items: Suggestion[] } | { kind: 'offline' };

export function Search() {
  const { t } = useApp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Results>({ kind: 'none' });
  const seq = useRef(0);
  const recent = useLive(() => db.myWords.orderBy('addedAt').reverse().filter((w) => w.status !== 'archived').limit(8).toArray(), []);

  useEffect(() => {
    const query = q.trim();
    const n = ++seq.current;
    if (!query) return setResults({ kind: 'none' });
    const id = setTimeout(async () => {
      let r: Results;
      if (isKorean(query)) {
        const items = await koSearch(query);
        r = items === null ? { kind: 'offline' } : { kind: 'ko', q: query, items };
      } else {
        r = { kind: 'en', items: await suggest(query) };
      }
      if (n === seq.current) setResults(r);
    }, 150);
    return () => clearTimeout(id);
  }, [q]);

  function submit(e: Event) {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    // Korean goes to the first English match; English opens the word (AI fills it if needed).
    if (isKorean(query)) {
      if (results.kind === 'ko' && results.items[0]) go('word', results.items[0].key);
      return;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    go('word', query);
  }

  return (
    <Page title={t('search.title')}>
      <form class="search-form" onSubmit={submit} role="search">
        <input class="input big" type="search" value={q} placeholder={t('search.placeholder')} enterkeyhint="search"
          autocapitalize="off" autocorrect="off" spellcheck={false} aria-label={t('search.placeholder')}
          onInput={(e) => setQ(e.currentTarget.value)} />
        <button class="btn primary" type="submit">{t('search.go')}</button>
      </form>

      {results.kind === 'none' && (
        <>
          <p class="muted small">{t('search.hint')}</p>
          {recent && recent.length > 0 && (
            <>
              <h2 class="section-title">{t('search.recent')}</h2>
              <WordList items={recent.map((w) => ({ key: w.word, word: w.display, ko: w.ko }))} />
            </>
          )}
        </>
      )}
      {results.kind === 'offline' && <p class="muted">{t('search.offline')}</p>}
      {results.kind === 'ko' && (
        results.items.length ? (
          <>
            <h2 class="section-title">{t('search.koResults', { q: results.q })}</h2>
            <WordList items={results.items} />
          </>
        ) : (
          <p class="muted">{t('search.noKoResults', { q: results.q })}</p>
        )
      )}
      {results.kind === 'en' && results.items.length > 0 && <WordList items={results.items} />}
    </Page>
  );
}

export function WordList({ items, trailing }: { items: Suggestion[]; trailing?: (s: Suggestion) => preact.ComponentChildren }) {
  return (
    <ul class="list word-list">
      {items.map((s) => (
        <li key={s.key}>
          <a href={href('word', s.key)}>
            <span class="wl-main">
              <span class="wl-word" lang="en">{s.word}</span>
              <span class="wl-ko">{s.ko.join(', ')}</span>
            </span>
            {trailing?.(s)}
          </a>
        </li>
      ))}
    </ul>
  );
}
