import { useEffect, useState } from 'preact/hooks';
import { AiUnavailable } from '../ai/dictionary';
import { GeminiError } from '../ai/gemini';
import { Icon } from '../components/Icon';
import { Page } from '../components/Layout';
import { db, type Level, type Pack } from '../db/schema';
import { useLive } from '../hooks/useLive';
import type { StringKey } from '../i18n';
import { FIXED_PACKS, type PackWord } from '../packs/fixed';
import { addFromPack, aiPacks, generatePacks, profileHash, resolveRows, type PackRow } from '../packs/packs';
import { href } from '../router';
import { useApp } from '../state';

export function Packs() {
  const { t, settings } = useApp();
  const lang = settings.uiLang;
  const ai = useLive(() => aiPacks(), []);
  const savedCount = useLive(() => db.myWords.count(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = settings.profile;
  const profileEmpty = !p.occupation && !p.goals.length;
  const stale = ai && ai.length > 0 && ai[0].generatedFrom !== profileHash(settings);

  async function make() {
    setBusy(true);
    setError('');
    try {
      await generatePacks(settings);
    } catch (e) {
      setError(
        e instanceof AiUnavailable || (e as Error).message === 'unavailable' ? t('word.aiUnavailable')
          : e instanceof GeminiError && e.kind === 'rate-limit' ? t('word.aiBusy')
          : t('word.aiError'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t('more.packs')} back="more">
      <p class="small">
        {t('packs.myLevel')}: <strong>{t(`level.${p.level}` as StringKey)}</strong>{' '}
        <a href={href('settings')}>{t('packs.changeLevel')}</a>
      </p>

      <h2 class="section-title">{t('packs.forYou')}</h2>
      <section class="card">
        {profileEmpty && <p class="muted small">{t('packs.fillProfile')} <a href={href('settings')}>{t('more.settings')}</a></p>}
        {stale && <p class="muted small">{t('packs.stale')}</p>}
        {ai && ai.length > 0 && (
          <ul class="list pack-list flush-list">
            {ai.map((pk) => <PackLink key={pk.id} id={pk.id} icon="✨" title={pk.title} desc={pk.description ?? ''} words={pk.words} />)}
          </ul>
        )}
        <button class="btn primary block" disabled={busy} onClick={make}>
          {busy ? t('packs.making') : ai && ai.length ? t('packs.remake') : t('packs.make')}
        </button>
        {error && <p class="status error small">{error}</p>}
        {savedCount !== undefined && <p class="muted tiny">{t('packs.aiNote')}</p>}
      </section>

      <h2 class="section-title">{t('packs.topics')}</h2>
      <ul class="list pack-list">
        {FIXED_PACKS.map((pk) => (
          <PackLink key={pk.id} id={pk.id} icon={pk.icon} title={pk.title[lang]} desc={pk.desc[lang]} words={pk.words.map((w) => w.w)} />
        ))}
      </ul>
    </Page>
  );
}

function PackLink({ id, icon, title, desc, words }: { id: string; icon: string; title: string; desc: string; words: string[] }) {
  const { t } = useApp();
  const saved = useLive(async () => {
    const keys = new Set((await db.myWords.toCollection().primaryKeys()) as string[]);
    return words.filter((w) => keys.has(w.toLowerCase())).length;
  }, [id]);
  return (
    <li>
      <a href={href('pack', id)}>
        <span class="pack-icon" aria-hidden="true">{icon}</span>
        <span class="wl-main">
          <span class="wl-word">{title}</span>
          <span class="wl-ko">{desc}</span>
          <span class="tiny muted">{t('packs.count', { saved: saved ?? 0, total: words.length })}</span>
        </span>
        <Icon name="chevron" size={20} />
      </a>
    </li>
  );
}

type Filter = 'mine' | 'all';

export function PackScreen({ id }: { id: string }) {
  const { t, settings } = useApp();
  const lang = settings.uiLang;
  const fixed = FIXED_PACKS.find((p) => p.id === id);
  const stored = useLive(() => (fixed ? Promise.resolve(undefined) : db.packs.get(id)), [id]) as Pack | undefined;
  const [rows, setRows] = useState<PackRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>(id === 'konglish' ? 'all' : 'mine');
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<{ done: number; total: number; skipped: number } | null>(null);

  const title = fixed ? `${fixed.icon} ${fixed.title[lang]}` : stored ? `✨ ${stored.title}` : t('more.packs');
  const desc = fixed ? fixed.desc[lang] : stored?.description;
  const words: PackWord[] | null = fixed
    ? fixed.words
    : stored ? stored.words.map((w) => ({ w, note: stored.notes?.[w] })) : null;

  useEffect(() => {
    if (words) resolveRows(words).then(setRows);
  }, [id, !!words]);

  const level: Level = settings.profile.level;
  // "My level" also keeps words whose level is unknown (phrases filled by AI on demand).
  const visible = (rows ?? []).filter((r) => filter === 'all' || !r.level || r.level === level);
  const mineCount = (rows ?? []).filter((r) => !r.level || r.level === level).length;
  const unsaved = visible.filter((r) => !r.saved);

  async function add(row: PackRow): Promise<boolean> {
    setAdding((a) => ({ ...a, [row.key]: true }));
    try {
      const res = await addFromPack(row.key, settings);
      if (res === 'unavailable') return false;
      setRows((rs) => rs && rs.map((r) => (r.key === row.key ? { ...r, saved: true } : r)));
      return true;
    } catch {
      return false;
    } finally {
      setAdding((a) => ({ ...a, [row.key]: false }));
    }
  }

  async function addAll() {
    const todo = unsaved;
    let skipped = 0;
    setProgress({ done: 0, total: todo.length, skipped: 0 });
    for (const [i, r] of todo.entries()) {
      if (!(await add(r))) skipped++;
      setProgress({ done: i + 1, total: todo.length, skipped });
    }
  }

  return (
    <Page title={title} back="packs">
      {desc && <p class="muted small">{desc}</p>}
      {rows === null ? (
        <p class="muted center">{t('word.loading')}</p>
      ) : (
        <>
          <div class="chips filter-chips">
            <button class={`chip ${filter === 'mine' ? 'on' : ''}`} aria-pressed={filter === 'mine'} onClick={() => setFilter('mine')}>
              {t('packs.filterMine', { level: t(`level.${level}` as StringKey) })} <span class="count">{mineCount}</span>
            </button>
            <button class={`chip ${filter === 'all' ? 'on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              {t('words.filter.all')} <span class="count">{rows.length}</span>
            </button>
          </div>

          {unsaved.length > 0 && !progress && (
            <button class="btn primary block" onClick={addAll}>{t('packs.addAll', { n: unsaved.length })}</button>
          )}
          {progress && (
            <p class={`status ${progress.done === progress.total ? 'ok' : ''} small`}>
              {progress.done < progress.total
                ? t('packs.adding', { done: progress.done, total: progress.total })
                : t('packs.added', { n: progress.total - progress.skipped })}
              {progress.skipped > 0 && ` ${t('packs.skipped', { n: progress.skipped })}`}
            </p>
          )}

          {visible.length === 0 ? (
            <p class="muted center">{t('packs.noneAtLevel')}</p>
          ) : (
            <ul class="list word-list pack-words">
              {visible.map((r) => (
                <li key={r.key}>
                  <div class="pw-row">
                    <a class="pw-main" href={href('word', r.key)}>
                      <span class="wl-word" lang="en">
                        {r.display}
                        {r.level && <span class={`lvl ${r.level}`}>{t(`level.${r.level}` as StringKey)}</span>}
                      </span>
                      {r.k && <span class="pw-konglish">{r.k} ✗ → <strong lang="en">{r.display}</strong> ✓</span>}
                      {r.ko.length > 0 && <span class="wl-ko">{r.ko.join(', ')}</span>}
                      {r.note && <span class="pw-note">{r.note}</span>}
                    </a>
                    {r.saved ? (
                      <span class="pw-saved" aria-label={t('word.saved')}>✓</span>
                    ) : (
                      <button class="btn pw-add" disabled={adding[r.key]} onClick={() => add(r)} aria-label={t('word.save')}>
                        {adding[r.key] ? '…' : '+'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
}
