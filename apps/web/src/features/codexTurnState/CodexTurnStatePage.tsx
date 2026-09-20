import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useAuthStore, useNotificationStore } from '@/stores';
import { codexTurnStateApi } from '@/services/api';
import type { CodexTurnStateStatus } from '@/types/codexTurnState';
import { getErrorMessage } from '@/utils/helpers';
import styles from './CodexTurnStatePage.module.scss';

const splitLines = (value: string) =>
  value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

const formatRemaining = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

export function CodexTurnStatePage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [status, setStatus] = useState<CodexTurnStateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState('');
  const [proxy, setProxy] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [failClosed, setFailClosed] = useState(true);

  const load = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setLoading(false);
      setError(t('notification.connection_required'));
      return;
    }
    try {
      const next = await codexTurnStateApi.status();
      setStatus(next);
      setEnabled(next.enabled);
      setFailClosed(next.failClosed);
      setModels(next.models.join('\n'));
      setProxy(next.harvestProxyUrl);
      setError('');
    } catch (err: unknown) {
      setError(getErrorMessage(err, t('codex_turn_state.load_failed')));
    } finally {
      setLoading(false);
    }
  }, [connectionStatus, t]);

  const refreshStatus = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    try {
      const next = await codexTurnStateApi.status();
      setStatus(next);
      setError('');
    } catch (err: unknown) {
      setError(getErrorMessage(err, t('codex_turn_state.load_failed')));
    }
  }, [connectionStatus, t]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void refreshStatus(), 10_000);
    return () => window.clearInterval(timer);
  }, [load, refreshStatus]);

  const save = async () => {
    if (!status) return;
    setSaving(true);
    try {
      const next = await codexTurnStateApi.update({
        enabled,
        fail_closed: failClosed,
        harvest_proxy_url: proxy,
        models: splitLines(models),
        target_length: status.targetLength,
        ttl_seconds: status.ttlSeconds,
        refresh_before_seconds: status.refreshBeforeSeconds,
        probe_interval_seconds: status.probeIntervalSeconds,
        attempt_timeout_seconds: status.attemptTimeoutSeconds,
      });
      setStatus(next);
      setProxy(next.harvestProxyUrl);
      showNotification(t('codex_turn_state.updated'), 'success');
    } catch (err: unknown) {
      showNotification(getErrorMessage(err, t('codex_turn_state.action_failed')), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error && !status) {
    return (
      <div className={styles.page}>
        <EmptyState title={t('codex_turn_state.title')} description={error} />
        <div className={styles.actions}>
          <Button onClick={() => void load()}>{t('common.retry')}</Button>
        </div>
      </div>
    );
  }
  if (!status) return null;

  const allModels = Array.from(
    new Set([
      ...status.models,
      ...status.accounts.flatMap((account) => account.tickets.map((ticket) => ticket.model)),
    ])
  );
  const readyCount = status.accounts.reduce(
    (count, account) => count + account.tickets.filter((ticket) => ticket.ready).length,
    0
  );
  const totalCount = status.accounts.reduce((count, account) => count + account.tickets.length, 0);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('codex_turn_state.title')}</h1>
          <div className={styles.muted}>{t('codex_turn_state.native_description')}</div>
        </div>
        <div className={styles.actions}>
          <Button disabled={saving} onClick={() => void load()}>
            {t('common.refresh')}
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      </header>

      {error ? <div className={styles.notice}>{error}</div> : null}
      <section className={styles.stats} aria-label={t('codex_turn_state.summary')}>
        <div className={styles.stat}>
          <span className={styles.muted}>{t('codex_turn_state.enabled')}</span>
          <strong className={styles.statValue}>
            {status.enabled ? t('common.yes') : t('common.no')}
          </strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.muted}>{t('codex_turn_state.ready')}</span>
          <strong className={styles.statValue}>
            {readyCount}/{totalCount}
          </strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.muted}>{t('codex_turn_state.ttl')}</span>
          <strong className={styles.statValue}>{formatRemaining(status.ttlSeconds)}</strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.muted}>{t('codex_turn_state.refresh_before')}</span>
          <strong className={styles.statValue}>
            {formatRemaining(status.refreshBeforeSeconds)}
          </strong>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2>{t('codex_turn_state.settings')}</h2>
            <div className={styles.muted}>{t('codex_turn_state.settings_description')}</div>
          </div>
        </div>
        <div className={styles.scopeGrid}>
          <label className={styles.field}>
            <span>{t('codex_turn_state.enabled')}</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
          </label>
          <label className={styles.field}>
            <span>{t('codex_turn_state.fail_closed')}</span>
            <input
              type="checkbox"
              checked={failClosed}
              onChange={(event) => setFailClosed(event.target.checked)}
            />
          </label>
          <label className={styles.field}>
            <span>{t('codex_turn_state.harvest_proxy')}</span>
            <input
              value={proxy}
              onChange={(event) => setProxy(event.target.value)}
              placeholder="socks5://user:password@host:1080"
            />
          </label>
          <label className={styles.field}>
            <span>{t('codex_turn_state.models')}</span>
            <textarea value={models} onChange={(event) => setModels(event.target.value)} />
          </label>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <h2>{t('codex_turn_state.bucket_title')}</h2>
            <div className={styles.muted}>{t('codex_turn_state.bucket_description')}</div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('codex_turn_state.account')}</th>
                {allModels.map((model) => (
                  <th key={model}>{model}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {status.accounts.map((account) => (
                <tr key={account.id}>
                  <th>{account.name || account.id}</th>
                  {allModels.map((model) => {
                    const ticket = account.tickets.find((item) => item.model === model);
                    return (
                      <td key={model}>
                        {ticket?.ready ? (
                          <span className={styles.ready}>
                            {formatRemaining(ticket.remainingSeconds)}
                          </span>
                        ) : (
                          <span className={styles.missing}>
                            {ticket?.blocked
                              ? t('codex_turn_state.blocked')
                              : t('codex_turn_state.missing')}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
