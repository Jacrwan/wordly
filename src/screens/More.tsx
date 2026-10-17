import { Icon } from '../components/Icon';
import { Page } from '../components/Layout';
import type { StringKey } from '../i18n';
import { href, type Route } from '../router';
import { useApp } from '../state';

const groups: { route: Route; label: StringKey }[][] = [
  [
    { route: 'player', label: 'more.player' },
    { route: 'reader', label: 'more.reader' },
    { route: 'packs', label: 'more.packs' },
    { route: 'chat', label: 'more.chat' },
    { route: 'podcast', label: 'more.podcast' },
  ],
  [
    { route: 'settings', label: 'more.settings' },
    { route: 'about', label: 'more.about' },
  ],
];

export function More() {
  const { t } = useApp();
  return (
    <Page title={t('more.title')}>
      {groups.map((items, i) => (
        <ul class="list" key={i}>
          {items.map((it) => (
            <li key={it.route}>
              <a href={href(it.route)}>
                <span>{t(it.label)}</span>
                <Icon name="chevron" size={20} />
              </a>
            </li>
          ))}
        </ul>
      ))}
    </Page>
  );
}
