import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ConfigSection } from '@/components/config/ConfigSection';
import { IconTimer } from '@/components/ui/icons';
import { useAuthStore, useNotificationStore } from '@/stores';
import { codexTurnStateApi } from '@/services/api';
import type { CodexTurnStateStatus } from '@/types/codexTurnState';
import { getErrorMessage } from '@/utils/helpers';
import styles from './CodexTurnStateSettingsCard.module.scss';

const splitLines = (value: string) =>
  value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

export function CodexTurnStateSettingsCard({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [status, setStatus] = useState<CodexTurnStateStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [failClosed, setFailClosed] = useState(true);
  const [models, setModels] = useState('');
  const [proxy, setProxy] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setLoading(false);
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

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <ConfigSection
      title={t('codex_turn_state.settings')}
      description={t('codex_turn_state.settings_description')}
      icon={<IconTimer size={18} />}
    >
      {loading ? <div className={styles.muted}>{t('config_management.status_loading')}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      {status ? (
        <div className={styles.content}>
          <div className={styles.toggleGrid}>
            <div className={styles.toggleField}>
              <div>
                <strong>{t('codex_turn_state.enabled')}</strong>
                <span>{t('codex_turn_state.global_settings_hint')}</span>
              </div>
              <ToggleSwitch
                checked={enabled}
                onChange={setEnabled}
                disabled={disabled || saving}
                ariaLabel={t('codex_turn_state.enabled')}
              />
            </div>
            <div className={styles.toggleField}>
              <div>
                <strong>{t('codex_turn_state.fail_closed')}</strong>
                <span>{t('codex_turn_state.fail_closed_hint')}</span>
              </div>
              <ToggleSwitch
                checked={failClosed}
                onChange={setFailClosed}
                disabled={disabled || saving}
                ariaLabel={t('codex_turn_state.fail_closed')}
              />
            </div>
          </div>
          <label className={styles.field}>
            <span>{t('codex_turn_state.models')}</span>
            <textarea
              value={models}
              onChange={(event) => setModels(event.target.value)}
              disabled={disabled || saving}
              rows={3}
            />
          </label>
          <label className={styles.field}>
            <span>{t('codex_turn_state.harvest_proxy')}</span>
            <Input
              value={proxy}
              onChange={(event) => setProxy(event.target.value)}
              disabled={disabled || saving}
              placeholder="socks5://user:password@host:1080"
            />
          </label>
          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={disabled || saving}
              loading={saving}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : null}
    </ConfigSection>
  );
}
