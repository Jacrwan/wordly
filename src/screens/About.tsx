import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Layout';
import { useApp } from '../state';

const sources = [
  { name: 'Wiktionary', url: 'https://en.wiktionary.org/', via: 'kaikki.org / wiktextract', license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', desc: 'about.wiktionary' },
  { name: 'OpenSubtitles', url: 'https://www.opensubtitles.org/', via: 'OPUS', license: 'Lison & Tiedemann (2016), OpenSubtitles2016',
    licenseUrl: 'https://opus.nlpl.eu/OpenSubtitles/corpus/version/OpenSubtitles', desc: 'about.opensubtitles' },
  { name: 'wordfreq', url: 'https://github.com/rspeer/wordfreq', license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', desc: 'about.wordfreq' },
  { name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/', license: 'CC BY-SA (per file)',
    licenseUrl: 'https://commons.wikimedia.org/wiki/Commons:Licensing', desc: 'about.commons' },
] as const;

export function About() {
  const { t } = useApp();
  return (
    <Page title={t('about.title')} back="more">
      <p>{t('about.intro')}</p>
      <h2>{t('about.sources')}</h2>
      <ul class="list sources">
        {sources.map((s) => (
          <li key={s.name}>
            <div>
              <a href={s.url} target="_blank" rel="noopener"><strong>{s.name}</strong></a>
              {'via' in s && <span class="muted"> ({s.via})</span>}
              <div class="muted small">{t(s.desc)}</div>
              <a class="small" href={s.licenseUrl} target="_blank" rel="noopener">{s.license}</a>
            </div>
          </li>
        ))}
      </ul>
      <p class="muted small">{t('about.ai')}</p>
      <p class="muted small">{t('about.version')} {__APP_VERSION__}</p>
      <ScreenInfo />
    </Page>
  );
}

// Viewport numbers for debugging iOS layout reports (tab bar gaps, notch overlap).
function ScreenInfo() {
  const [info, setInfo] = useState('');
  useEffect(() => {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)';
    document.body.append(probe);
    const update = () => {
      const cs = getComputedStyle(probe);
      const vv = window.visualViewport;
      const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
      const safari = navigator.userAgent.match(/Version\/([\d.]+)/)?.[1] ?? '?';
      setInfo(
        `screen ${screen.width}×${screen.height} · window ${innerWidth}×${innerHeight}\n` +
          `visual ${vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} @${Math.round(vv.offsetTop)}` : '-'} · ` +
          `safe ${cs.paddingTop}/${cs.paddingBottom}\n` +
          `standalone ${standalone} · Safari ${safari}`,
      );
    };
    update();
    addEventListener('resize', update);
    visualViewport?.addEventListener('resize', update);
    return () => {
      probe.remove();
      removeEventListener('resize', update);
      visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return <p class="muted small mono diag">{info}</p>;
}
