import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/useAuthStore';
import { clusterApi, INSTANCES_CHANGED_EVENT, type CPAInstance } from '@/services/api/cluster';
import { instanceIdFromBase, managerRootBase } from '@/utils/instanceScope';
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
  const globalManagementPage = ['/instances', '/manager-config'].includes(
    pathname.replace(/\/+$/, '')
  );
  const root = managerRootBase(base);
  const api = useMemo(() => clusterApi(root, key), [root, key]);
  const [query, setQuery] = useState('');
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const currentId = instanceIdFromBase(base);
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
    if (mode !== 'manager_embedded' || globalManagementPage) return;
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
  }, [api, mode, revision, globalManagementPage]);
  // Keep history synchronization mounted even when this global page has no scope picker.
  if (mode !== 'manager_embedded' || globalManagementPage) return null;
  return (
    <div className={`${styles.toolbar} ${styles.workspace}`} aria-label={t('cluster.scope')}>
      {items.length > 5 ? (
        <details
          ref={pickerRef}
          className={styles.picker}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && pickerRef.current) {
              pickerRef.current.open = false;
              pickerRef.current.querySelector('summary')?.focus();
            }
          }}
        >
          <summary>
            {t('cluster.scope')}:{' '}
            {items.find((item) => item.id === currentId)?.name || t('cluster.all')}
          </summary>
          <div className={styles.pickerPanel}>
            <input
              type="search"
              aria-label={t('cluster.searchInstances')}
              placeholder={t('cluster.searchInstances')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className={styles.pickerOptions}>
              {(aggregateRoutes.has(pathname)
                ? [
                    { id: '', name: t('cluster.all'), enabled: true, ready: true, baseUrl: '' },
                    ...items,
                  ]
                : items
              )
                .filter((item) =>
                  `${item.name} ${item.baseUrl}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase())
                )
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={currentId === item.id}
                    disabled={!item.enabled || !item.ready}
                    onClick={() => {
                      if (pickerRef.current) pickerRef.current.open = false;
                      setQuery('');
                      navigateInstance(item.id, `${pathname}${search}`);
                    }}
                  >
                    <strong>{item.name}</strong>
                    <small>{item.baseUrl}</small>
                  </button>
                ))}
              {query &&
                !items.some((item) =>
                  `${item.name} ${item.baseUrl}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase())
                ) && <p>{t('cluster.noMatches')}</p>}
            </div>
          </div>
        </details>
      ) : (
        <label>
          {t('cluster.scope')}
          <select
            className={styles.scopeSelect}
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
      )}
      <span className={styles.scopeMeta}>
        {currentId
          ? items.find((item) => item.id === currentId)?.baseUrl
          : t('cluster.instanceSummary', {
              enabled: items.filter((item) => item.enabled).length,
              total: items.length,
            })}
      </span>
      <Link
        to="/instances"
      >
        {t('cluster.manage')}
      </Link>
      {error && (
        <span role="alert" className={styles.errorMessage}>
          {t('cluster.loadError')}{' '}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            {t('cluster.refresh')}
          </button>
        </span>
      )}
      {failedSources.length > 0 && (
        <details className={styles.partialMessage}>
          <summary role="status">
            {t('cluster.partialTitle', { count: failedSources.length })}
          </summary>
          <p>{t('cluster.partialData', { instances: failedSources.join('、') })}</p>
          <Link to="/instances">{t('cluster.manage')}</Link>
        </details>
      )}
    </div>
  );
}
