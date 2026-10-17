import { Page } from '../components/Layout';
import { useApp } from '../state';

const sources = [
  { name: 'Wiktionary', url: 'https://en.wiktionary.org/', via: 'kaikki.org / wiktextract', license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', desc: 'about.wiktionary' },
  { name: 'Tatoeba', url: 'https://tatoeba.org/', license: 'CC BY 2.0 FR',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/fr/', desc: 'about.tatoeba' },
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
    </Page>
  );
}
