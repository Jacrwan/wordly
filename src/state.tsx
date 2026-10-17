import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { loadSettings, saveSettings, type Settings } from './db/schema';
import { makeT, type Translate } from './i18n';
import { setPreferredVoices } from './speech/engine';

interface AppState {
  settings: Settings;
  /** Pass a function to derive the patch from the latest saved settings (safe for rapid taps). */
  update: (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => Promise<void>;
  t: Translate;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ComponentChildren }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  // Writes are queued so two quick taps can't both read the old settings and overwrite each other.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const update = useCallback<AppState['update']>((patch) => {
    const run = queue.current.then(async () => {
      const current = await loadSettings();
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
      await saveSettings(next);
      setSettings(next);
    });
    queue.current = run.catch(() => {});
    return run;
  }, []);

  const value = useMemo(
    () => (settings ? { settings, update, t: makeT(settings.uiLang) } : null),
    [settings, update],
  );

  useEffect(() => {
    if (settings) document.documentElement.lang = settings.uiLang;
  }, [settings?.uiLang]);

  useEffect(() => {
    if (settings) setPreferredVoices({ 'en-US': settings.speech.enVoice, 'ko-KR': settings.speech.koVoice });
  }, [settings?.speech.enVoice, settings?.speech.koVoice]);

  if (!value) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppStateProvider');
  return v;
}
