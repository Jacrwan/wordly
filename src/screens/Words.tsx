import { useState } from 'preact/hooks';
import { Page } from '../components/Layout';
import { db, type WordStatus } from '../db/schema';
import { useLive } from '../hooks/useLive';
import type { StringKey } from '../i18n';
import { useApp } from '../state';
import { WordList } from './Search';

type Filter = 'all' | WordStatus;
const FILTERS: Filter[] = ['all', 'learning', 'mastered', 'archived'];

export function Words() {
  const { t } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const words = useLive(() => db.myWords.orderBy('addedAt').reverse().toArray(), []);

  if (!words) return <Page title={t('words.title')}>{null}</Page>;

  // "All" means everything still in play; archived words only show under their own filter.
  const count = (f: Filter) => words.filter((w) => (f === 'all' ? w.status !== 'archived' : w.status === f)).length;
  const needle = q.trim().toLowerCase();
  const shown = words.filter((w) =>
    (filter === 'all' ? w.status !== 'archived' : w.status === filter) &&
    (!needle || w.word.includes(needle) || w.ko.some((k) => k.includes(needle))),
  );

  return (
    <Page title={t('words.title')}>
      {words.length === 0 ? (
        <p class="muted center">{t('words.empty')}</p>
      ) : (
        <>
          <input class="input" type="search" value={q} placeholder={t('words.search')} aria-label={t('words.search')}
            autocapitalize="off" autocorrect="off" spellcheck={false} onInput={(e) => setQ(e.currentTarget.value)} />
          <div class="chips filter-chips" role="tablist">
            {FILTERS.map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} class={`chip ${filter === f ? 'on' : ''}`}
                onClick={() => setFilter(f)}>
                {t(`words.filter.${f}` as StringKey)} <span class="count">{count(f)}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p class="muted center">{t('words.noMatch')}</p>
          ) : (
            <WordList
              items={shown.map((w) => ({ key: w.word, word: w.display, ko: w.ko }))}
              trailing={(s) => {
                const status = words.find((w) => w.word === s.key)?.status;
                return status && status !== 'learning' ? (
                  <span class={`badge ${status}`}>{t(`words.filter.${status}` as StringKey)}</span>
                ) : null;
              }}
            />
          )}
        </>
      )}
    </Page>
  );
}
