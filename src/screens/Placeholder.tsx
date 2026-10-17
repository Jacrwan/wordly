import { ComingSoon, Page } from '../components/Layout';
import type { StringKey } from '../i18n';
import { useApp } from '../state';

export function Placeholder({ title, step }: { title: StringKey; step: number }) {
  const { t } = useApp();
  return (
    <Page title={t(title)} back="more">
      <ComingSoon step={step} />
    </Page>
  );
}
