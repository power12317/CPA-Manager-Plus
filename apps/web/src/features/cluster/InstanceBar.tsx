import { useEffect, useMemo, useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/useAuthStore';
import { clusterApi, INSTANCES_CHANGED_EVENT, type CPAInstance } from '@/services/api/cluster';
import { instanceIdFromBase } from '@/utils/instanceScope';
import { navigateInstance, synchronizeInstanceHistory } from './navigation';
import { aggregateRoutes } from './instanceSelection';
import styles from './cluster.module.scss';
import { AGGREGATE_COVERAGE_EVENT } from '@/utils/aggregateScope';

export function InstanceBar() {
  const { t } = useTranslation();
  const base = useAuthStore((s) => s.apiBase);
  const key = useAuthStore((s) => s.managementKey);
  const mode = useAuthStore((s) => s.sessionMode);
  const { pathname, search } = useLocation();
  const api = useMemo(() => clusterApi(base, key), [base, key]);
  const [items, setItems] = useState<CPAInstance[]>([]);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [coverageState, setCoverageState] = useState<{ base: string; failures: string[] } | null>(
    null
  );
  const failedSources = coverageState?.base === base ? coverageState.failures : [];
  useEffect(() => {
    window.addEventListener('popstate', synchronizeInstanceHistory);
    return () => window.removeEventListener('popstate', synchronizeInstanceHistory);
  }, []);
  useEffect(() => {
    const failures = new Map<string, string[]>();
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; coverage: { failures?: string[] } }>)
        .detail;
      if (!detail?.path) return;
      failures.set(
        detail.path,
        detail.coverage?.failures?.filter((name) => typeof name === 'string') || []
      );
      setCoverageState({ base, failures: [...new Set([...failures.values()].flat())] });
    };
    window.addEventListener(AGGREGATE_COVERAGE_EVENT, update);
    return () => window.removeEventListener(AGGREGATE_COVERAGE_EVENT, update);
  }, [base]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(INSTANCES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(INSTANCES_CHANGED_EVENT, refresh);
  }, []);
  useEffect(() => {
    if (mode !== 'manager_embedded') return;
    const controller = new AbortController();
    api
      .list(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setItems(value);
          setError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [api, mode, revision]);
  if (mode !== 'manager_embedded') return null;
  return (
    <div className={styles.toolbar}>
      <label>
        {t('cluster.scope')}
        <select
          value={instanceIdFromBase(base)}
          onChange={(e) => {
            const id = e.target.value;
            navigateInstance(id, `${pathname}${search}`);
          }}
        >
          {aggregateRoutes.has(pathname) && <option value="">{t('cluster.all')}</option>}
          {items.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.enabled || !item.ready}>
              {item.name}
              {!item.enabled ? ` (${t('cluster.disabled')})` : ''}
            </option>
          ))}
        </select>
      </label>
      <Link to="/config" onClick={() => localStorage.setItem('config-management:tab', 'manager')}>
        {t('cluster.manage')}
      </Link>
      {error && <span role="alert">{t('cluster.loadError')}</span>}
      {failedSources.length > 0 && (
        <span role="status">
          {t('cluster.partialData', { instances: failedSources.join('、') })}
        </span>
      )}
    </div>
  );
}
