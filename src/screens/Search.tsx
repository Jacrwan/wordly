import { ComingSoon, Page } from '../components/Layout';
import { useApp } from '../state';

export function Search() {
  const { t } = useApp();
  return (
    <Page title={t('search.title')}>
      <input class="input big" type="search" placeholder={t('search.placeholder')} disabled
        autocapitalize="off" autocorrect="off" spellcheck={false} />
      <ComingSoon step={3} />
    </Page>
  );
}
