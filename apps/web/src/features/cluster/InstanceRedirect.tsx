import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useClusterClient, useClusterData } from './useClusterData';
import { latestAvailableInstance } from './instanceSelection';
import { navigateInstance } from './navigation';

// Strongly scoped pages choose a default automatically. The shared toolbar is
// the only instance selector; there is no second full-page selection step.
export function InstanceRedirect({ route }: { route: string }) {
  const { t } = useTranslation();
  const api = useClusterClient();
  const { data, loading, error, reload } = useClusterData(api.list);
  const target = data ? latestAvailableInstance(data) : undefined;
  useEffect(() => {
    if (target && !loading && !error) navigateInstance(target.id, route, true);
  }, [target, route, loading, error]);
  if (loading || (target && !error)) return <LoadingSpinner />;
  return (
    <div role="alert">
      <p>{t(error ? 'cluster.loadError' : 'cluster.noAvailableInstance')}</p>
      <Button variant="secondary" onClick={reload}>
        {t('cluster.refresh')}
      </Button>
    </div>
  );
}

export function ReturnToAggregate({ route }: { route: string }) {
  useEffect(() => {
    navigateInstance('', route, true);
  }, [route]);
  return <LoadingSpinner />;
}
