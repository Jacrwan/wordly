import { ComingSoon, Page } from '../components/Layout';
import { useApp } from '../state';

export function Review() {
  const { t } = useApp();
  return (
    <Page title={t('review.title')}>
      <ComingSoon step={4} />
    </Page>
  );
}
