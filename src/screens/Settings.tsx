import { useEffect, useRef, useState } from 'preact/hooks';
import { connFrom, GeminiError, listModels, pickModels } from '../ai/gemini';
import { Page } from '../components/Layout';
import { createBackup, deliverFile, parseBackup, restoreBackup } from '../db/backup';
import { downloadAll, offlineStatus, type OfflineStatus } from '../dict/store';
import type { Level, Profile, Settings, UiLang } from '../db/schema';
import type { StringKey } from '../i18n';
import { useApp } from '../state';

const AGE_RANGES = ['10s', '20s', '30s', '40s', '50s', '60s', '70+'];
const LEVELS: Level[] = ['beginner', 'intermediate', 'advanced'];
const GOALS = ['work', 'daily', 'travel', 'medical', 'housing', 'immigration', 'exam'] as const;
const DAILY_NEW = [5, 10, 15, 20, 30];

type Status = { kind: 'ok' | 'error' | 'busy'; text: string } | null;

export function SettingsScreen() {
  const { t } = useApp();
  return (
    <Page title={t('settings.title')} back="more">
      <LanguageSection />
      <AiSection />
      <ProfileSection />
      <StudySection />
      <OfflineSection />
      <StorageSection />
      <BackupSection />
    </Page>
  );
}

function LanguageSection() {
  const { t, settings, update } = useApp();
  const opts: { v: UiLang; label: string }[] = [
    { v: 'ko', label: '한국어' },
    { v: 'en', label: 'English' },
  ];
  return (
    <section class="card">
      <h2>{t('settings.language')}</h2>
      <div class="segmented" role="radiogroup">
        {opts.map((o) => (
          <button key={o.v} role="radio" aria-checked={settings.uiLang === o.v}
            class={settings.uiLang === o.v ? 'on' : ''} onClick={() => update({ uiLang: o.v })}>
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function AiSection() {
  const { t, settings, update } = useApp();
  const [code, setCode] = useState(settings.familyCode);
  const [key, setKey] = useState(settings.apiKey);
  const [showCode, setShowCode] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [showAll, setShowAll] = useState(false);

  // Saves the code or key only after Gemini answers, so a typo never replaces a working value.
  async function check(patch: Pick<Settings, 'familyCode' | 'apiKey'>, missing: StringKey) {
    const conn = connFrom(patch);
    if (!conn) return setStatus({ kind: 'error', text: t(missing) });
    setStatus({ kind: 'busy', text: t('settings.ai.checking') });
    try {
      const models = pickModels(await listModels(conn));
      await update({ ...patch, models });
      setStatus({ kind: 'ok', text: t('settings.ai.ok', { n: models.available.length }) });
    } catch (e) {
      const kind = (e as GeminiError).kind;
      const text = kind === 'bad-code' ? t('settings.family.wrong')
        : kind === 'invalid-key' ? t('settings.apiKey.invalid')
        : kind === 'rate-limit' ? t('settings.ai.rateLimit')
        : kind === 'proxy-config' ? t('settings.ai.proxyConfig')
        : kind === 'network' ? t('settings.ai.network')
        : t('settings.ai.error', { msg: (e as Error).message });
      setStatus({ kind: 'error', text });
    }
  }

  async function removeKey() {
    setKey('');
    await update({ apiKey: '' });
    setStatus(null);
  }

  const busy = status?.kind === 'busy';
  const m = settings.models;
  const rows: { label: StringKey; value: string | null | undefined }[] = [
    { label: 'settings.models.lookup', value: m?.lookup },
    { label: 'settings.models.long', value: m?.long },
    { label: 'settings.models.tts', value: m?.tts },
  ];

  return (
    <section class="card">
      <h2>{t('settings.ai')}</h2>

      <div class="field">
        <span>{t('settings.family')}</span>
        <p class="muted small flush">{t('settings.family.help')}</p>
        <div class="row">
          {/* Masked text fields avoid iOS offering to save these as passwords. */}
          <input class={`input mono ${showCode ? '' : 'masked'}`} type="text" value={code}
            placeholder={t('settings.family.placeholder')} autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck={false}
            onInput={(e) => setCode(e.currentTarget.value)} />
          <button class="btn ghost" onClick={() => setShowCode(!showCode)}>
            {showCode ? t('settings.secret.hide') : t('settings.secret.show')}
          </button>
        </div>
        <button class="btn primary block" disabled={busy}
          onClick={() => check({ familyCode: code.trim(), apiKey: '' }, 'settings.family.missing')}>
          {busy ? t('settings.ai.checking') : t('settings.family.check')}
        </button>
      </div>

      {settings.apiKey && <p class="muted small">{t('settings.ai.usingKey')}</p>}
      {status && !busy && <p class={`status ${status.kind}`} role="status">{status.text}</p>}

      {m && (
        <>
          <h3>{t('settings.models')}</h3>
          <dl class="kv">
            {rows.map((r) => (
              <div key={r.label}>
                <dt>{t(r.label)}</dt>
                <dd class="mono">{r.value ?? t('settings.models.none')}</dd>
              </div>
            ))}
          </dl>
          <button class="btn link" onClick={() => setShowAll(!showAll)}>
            {t('settings.models.all')} ({m.available.length})
          </button>
          {showAll && <ul class="models mono small">{m.available.map((id) => <li key={id}>{id}</li>)}</ul>}
        </>
      )}

      <details class="advanced" open={!!settings.apiKey}>
        <summary>{t('settings.apiKey.advanced')}</summary>
        <p class="muted small">{t('settings.apiKey.help')}{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">{t('settings.apiKey.link')}</a>
        </p>
        <div class="row">
          <input class={`input mono ${showKey ? '' : 'masked'}`} type="text" value={key} placeholder="AIza…"
            autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck={false}
            onInput={(e) => setKey(e.currentTarget.value)} />
          <button class="btn ghost" onClick={() => setShowKey(!showKey)}>
            {showKey ? t('settings.secret.hide') : t('settings.secret.show')}
          </button>
        </div>
        <div class="row gap-top">
          <button class="btn" disabled={busy}
            onClick={() => check({ familyCode: settings.familyCode, apiKey: key.trim() }, 'settings.apiKey.missing')}>
            {t('settings.apiKey.test')}
          </button>
          {settings.apiKey && <button class="btn ghost" onClick={removeKey}>{t('settings.apiKey.remove')}</button>}
        </div>
        <p class="muted small">{t('settings.apiKey.privacy')}</p>
      </details>
    </section>
  );
}

function ProfileSection() {
  const { t, settings, update } = useApp();
  const p = settings.profile;
  const [occupation, setOccupation] = useState(p.occupation);
  const setProfile = (patch: (cur: Profile) => Partial<Profile>) =>
    update((s) => ({ profile: { ...s.profile, ...patch(s.profile) } }));
  const toggleGoal = (g: string) =>
    setProfile((cur) => ({ goals: cur.goals.includes(g) ? cur.goals.filter((x) => x !== g) : [...cur.goals, g] }));

  return (
    <section class="card">
      <h2>{t('settings.profile')}</h2>
      <p class="muted small">{t('settings.profile.help')}</p>

      <label class="field">
        <span>{t('settings.profile.age')}</span>
        <select class="input" value={p.ageRange} onChange={(e) => { const ageRange = e.currentTarget.value; setProfile(() => ({ ageRange })); }}>
          <option value="">{t('age.choose')}</option>
          {AGE_RANGES.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>

      <label class="field">
        <span>{t('settings.profile.occupation')}</span>
        <input class="input" type="text" value={occupation} placeholder={t('settings.profile.occupation.ph')}
          onInput={(e) => setOccupation(e.currentTarget.value)}
          onBlur={() => occupation !== p.occupation && setProfile(() => ({ occupation: occupation.trim() }))} />
      </label>

      <div class="field">
        <span>{t('settings.profile.level')}</span>
        <div class="segmented">
          {LEVELS.map((l) => (
            <button key={l} class={p.level === l ? 'on' : ''} aria-pressed={p.level === l}
              onClick={() => setProfile(() => ({ level: l }))}>
              {t(`level.${l}`)}
            </button>
          ))}
        </div>
      </div>

      <div class="field">
        <span>{t('settings.profile.goals')}</span>
        <div class="chips">
          {GOALS.map((g) => (
            <button key={g} class={`chip ${p.goals.includes(g) ? 'on' : ''}`} aria-pressed={p.goals.includes(g)}
              onClick={() => toggleGoal(g)}>
              {t(`goal.${g}`)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function StudySection() {
  const { t, settings, update } = useApp();
  return (
    <section class="card">
      <h2>{t('settings.study')}</h2>
      <label class="field">
        <span>{t('settings.dailyNew')}</span>
        <select class="input" value={settings.dailyNewCards}
          onChange={(e) => update({ dailyNewCards: Number(e.currentTarget.value) })}>
          {DAILY_NEW.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </section>
  );
}

const fmtBytes = (n: number) =>
  n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

function StorageSection() {
  const { t } = useApp();
  const [info, setInfo] = useState<{ used: number; quota: number; persisted: boolean } | null>(null);
  useEffect(() => {
    (async () => {
      const est = await navigator.storage?.estimate?.();
      const persisted = (await navigator.storage?.persisted?.()) ?? false;
      if (est) setInfo({ used: est.usage ?? 0, quota: est.quota ?? 0, persisted });
    })().catch(() => {});
  }, []);
  if (!info) return null;
  return (
    <section class="card">
      <h2>{t('settings.storage')}</h2>
      <p>{t('settings.storage.used', { used: fmtBytes(info.used), quota: fmtBytes(info.quota) })}</p>
      <p class="muted small">{info.persisted ? t('settings.storage.persisted') : t('settings.storage.notPersisted')}</p>
    </section>
  );
}

function OfflineSection() {
  const { t } = useApp();
  const [info, setInfo] = useState<OfflineStatus | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Status>(null);
  useEffect(() => {
    offlineStatus().then(setInfo);
  }, []);

  async function download() {
    setResult(null);
    const ok = await downloadAll((done, total) => setProgress({ done, total }));
    setProgress(null);
    setInfo(await offlineStatus());
    setResult(ok ? { kind: 'ok', text: t('settings.offline.done') } : { kind: 'error', text: t('settings.offline.failed') });
  }

  const complete = info && info.stored >= info.total;
  return (
    <section class="card">
      <h2>{t('settings.offline')}</h2>
      <p class="muted small">{t('settings.offline.help')}</p>
      {info && <p class="small">{t('settings.offline.status', { stored: info.stored, total: info.total })}</p>}
      {progress ? (
        <>
          <progress class="progress" max={progress.total} value={progress.done} />
          <p class="small muted">{t('settings.offline.progress', progress)}</p>
        </>
      ) : (
        !complete && <button class="btn block" onClick={download}>{t('settings.offline.download')}</button>
      )}
      {result && <p class={`status ${result.kind}`} role="status">{result.text}</p>}
    </section>
  );
}

function BackupSection() {
  const { t } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>(null);

  async function exportIt() {
    const backup = await createBackup();
    const date = new Date().toISOString().slice(0, 10);
    await deliverFile(`wordly-backup-${date}.json`, JSON.stringify(backup));
    setStatus({ kind: 'ok', text: t('settings.backup.exported') });
  }

  async function importIt(file: File) {
    const backup = parseBackup(await file.text());
    if (!backup) return setStatus({ kind: 'error', text: t('settings.backup.badFile') });
    const n = Array.isArray(backup.data.myWords) ? backup.data.myWords.length : 0;
    if (!confirm(t('settings.backup.confirm', { n }))) return;
    const restored = await restoreBackup(backup);
    setStatus({ kind: 'ok', text: t('settings.backup.imported', { n: restored }) });
  }

  return (
    <section class="card">
      <h2>{t('settings.backup')}</h2>
      <p class="muted small">{t('settings.backup.help')}</p>
      <div class="row">
        <button class="btn" onClick={exportIt}>{t('settings.backup.export')}</button>
        <button class="btn" onClick={() => fileRef.current?.click()}>{t('settings.backup.import')}</button>
      </div>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) importIt(f);
        }} />
      {status && <p class={`status ${status.kind}`} role="status">{status.text}</p>}
    </section>
  );
}
