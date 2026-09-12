import { useTranslation } from 'react-i18next';
import { useClusterClient, useClusterData } from './useClusterData';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { navigateInstance } from './navigation';
import styles from './cluster.module.scss';

export function InstanceContribution() {
  const { t, i18n } = useTranslation();
  const api = useClusterClient();
  const { data, loading, error, reload } = useClusterData(api.dashboard);
  useHeaderRefresh(reload);
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <section className={styles.contribution} aria-busy={loading}>
      <div className={styles.toolbar}>
        <h2>{t('cluster.instanceContribution')}</h2>
        <button type="button" onClick={reload} disabled={loading}>
          {t('cluster.refresh')}
        </button>
      </div>
      {error ? (
        <p role="alert">{t('cluster.loadError')}</p>
      ) : !data ? (
        <div className={styles.skeleton} aria-label={t('common.loading')} />
      ) : (
        <>
          <p role="status">
            {t('cluster.coverage', { succeeded: data.succeeded, total: data.total })}
          </p>
          <div className={styles.contributionRows}>
            {data.instances.map((item) => (
              <button
                type="button"
                key={item.instanceId}
                className={styles.contributionRow}
                onClick={() => navigateInstance(item.instanceId, '/dashboard')}
              >
                <strong>{item.instanceName}</strong>
                {item.error ? (
                  <span>{t('cluster.unavailable')}</span>
                ) : (
                  <>
                    <span>
                      {t('cluster.calls')} <b>{number.format(item.data.today.total_calls)}</b>
                    </span>
                    <span>
                      {t('cluster.failed')} <b>{number.format(item.data.today.failure_calls)}</b>
                    </span>
                    <span>
                      {t('cluster.tokens')} <b>{number.format(item.data.today.total_tokens)}</b>
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
