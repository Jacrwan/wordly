import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLive } from '../hooks/useLive';
import { dismissPwa, onPwaChange, pwaState, updateSW } from '../pwa';
import { queueStats } from '../srs';
import { href, type Route } from '../router';
import { useApp } from '../state';
import { Icon, type IconName } from './Icon';

const tabs: { route: Route; icon: IconName; label: 'tab.search' | 'tab.words' | 'tab.review' | 'tab.more' }[] = [
  { route: 'search', icon: 'search', label: 'tab.search' },
  { route: 'words', icon: 'words', label: 'tab.words' },
  { route: 'review', icon: 'review', label: 'tab.review' },
  { route: 'more', icon: 'more', label: 'tab.more' },
];

// Sub-pages keep their tab highlighted: word pages stay under the tab they were opened from.
let lastTab: Route = 'search';
const tabFor = (r: Route): Route => {
  if (tabs.some((t) => t.route === r)) return (lastTab = r);
  return r === 'word' ? lastTab : 'more';
};

export function TabBar({ route }: { route: Route }) {
  const { t, settings } = useApp();
  const active = tabFor(route);
  const stats = useLive(() => queueStats(settings.dailyNewCards), [settings.dailyNewCards, route]);
  const waiting = stats ? stats.due + stats.fresh : 0;
  return (
    <nav class="tabbar">
      {tabs.map((tab) => (
        <a key={tab.route} href={href(tab.route)} class={tab.route === active ? 'active' : ''}
          aria-current={tab.route === active ? 'page' : undefined}>
          <span class="tab-icon">
            <Icon name={tab.icon} />
            {tab.route === 'review' && waiting > 0 && <span class="tab-badge">{waiting > 99 ? '99+' : waiting}</span>}
          </span>
          <span>{t(tab.label)}</span>
        </a>
      ))}
    </nav>
  );
}

export function Page({ title, back, onBack, children }: {
  title: string;
  back?: Route;
  onBack?: () => void;
  children: ComponentChildren;
}) {
  const { t } = useApp();
  return (
    <>
      <header class="topbar">
        {back && (
          <a class="back" href={href(back)} aria-label={t('common.back')}>
            <Icon name="back" />
          </a>
        )}
        {onBack && (
          <button class="back" onClick={onBack} aria-label={t('common.back')}>
            <Icon name="back" />
          </button>
        )}
        <h1>{title}</h1>
      </header>
      <main class="content">{children}</main>
    </>
  );
}

export function Banners() {
  const { t } = useApp();
  const [, force] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => onPwaChange(() => force((n) => n + 1)), []);
  useEffect(() => {
    if (!pwaState.offlineReady) return;
    const id = setTimeout(dismissPwa, 4000);
    return () => clearTimeout(id);
  }, [pwaState.offlineReady]);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, []);

  return (
    <div class="banners">
      {!online && <div class="banner warn">{t('common.offline')}</div>}
      {pwaState.needRefresh && (
        <div class="banner">
          <span>{t('update.available')}</span>
          <button class="btn small" onClick={() => updateSW(true)}>{t('update.reload')}</button>
        </div>
      )}
      {pwaState.offlineReady && (
        <div class="banner" onClick={dismissPwa}>{t('update.offlineReady')}</div>
      )}
    </div>
  );
}

export function ComingSoon({ step }: { step: number }) {
  const { t } = useApp();
  return <p class="muted center">{t('common.comingSoon', { step })}</p>;
}
