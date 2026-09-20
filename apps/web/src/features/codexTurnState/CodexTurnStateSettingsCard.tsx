import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ConfigSection } from '@/components/config/ConfigSection';
import { IconTimer } from '@/components/ui/icons';
import { useAuthStore } from '@/stores';
import { codexTurnStateApi } from '@/services/api/codexTurnState';
import type { VisualConfigValues } from '@/types/visualConfig';
import { getErrorMessage, isRecord } from '@/utils/helpers';
import styles from './CodexTurnStateSettingsCard.module.scss';

interface Props {
  disabled?: boolean;
  values: VisualConfigValues;
  onChange: (patch: Partial<VisualConfigValues>) => void;
}

// 配置值属于整页 YAML 草稿；接口只用于确认当前实例支持原生门票。
export function CodexTurnStateSettingsCard({ disabled = false, values, onChange }: Props) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const [retry, setRetry] = useState(0);
  const [capability, setCapability] = useState<{
    scope: string;
    state: 'ready' | 'unsupported' | 'error';
    error?: unknown;
  } | null>(null);
  const scope = JSON.stringify([apiBase, managementKey, connectionStatus, retry]);
  const current = capability?.scope === scope ? capability : null;

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    let active = true;
    const controller = new AbortController();
    codexTurnStateApi.status({ apiBase, managementKey }, controller.signal).then(
      () => {
        if (active) setCapability({ scope, state: 'ready' });
      },
      (error: unknown) => {
        if (!active) return;
        const unsupported = isRecord(error) && (error.status === 404 || error.status === 405);
        setCapability({ scope, state: unsupported ? 'unsupported' : 'error', error });
      }
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [apiBase, managementKey, connectionStatus, scope]);

  const blocked = disabled || current?.state !== 'ready';
  return (
    <ConfigSection
      title={t('codex_turn_state.settings')}
      description={t('codex_turn_state.settings_description')}
      icon={<IconTimer size={18} />}
    >
      {connectionStatus !== 'connected' ? (
        <p>{t('notification.connection_required')}</p>
      ) : !current ? (
        <p className={styles.muted}>{t('config_management.status_loading')}</p>
      ) : current.state === 'unsupported' ? (
        <p className={styles.muted}>{t('codex_turn_state.unsupported_backend')}</p>
      ) : current.state === 'error' ? (
        <div role="alert">
          <p className={styles.error}>
            {getErrorMessage(current.error, t('codex_turn_state.load_failed'))}
          </p>
          <Button onClick={() => setRetry((value) => value + 1)}>{t('common.retry')}</Button>
        </div>
      ) : null}
      {current?.state === 'ready' ? (
        <div className={styles.content}>
          <div className={styles.toggleGrid}>
            <div className={styles.toggleField}>
              <div>
                <strong>{t('codex_turn_state.enabled')}</strong>
                <span>{t('codex_turn_state.global_settings_hint')}</span>
              </div>
              <ToggleSwitch
                checked={values.codexTicketEnabled}
                onChange={(value) => onChange({ codexTicketEnabled: value })}
                disabled={blocked}
                ariaLabel={t('codex_turn_state.enabled')}
              />
            </div>
            <div className={styles.toggleField}>
              <div>
                <strong>{t('codex_turn_state.fail_closed')}</strong>
                <span>{t('codex_turn_state.fail_closed_hint')}</span>
              </div>
              <ToggleSwitch
                checked={values.codexTicketFailClosed}
                onChange={(value) => onChange({ codexTicketFailClosed: value })}
                disabled={blocked}
                ariaLabel={t('codex_turn_state.fail_closed')}
              />
            </div>
          </div>
          <label className={styles.field}>
            <span>{t('codex_turn_state.models')}</span>
            <textarea
              value={values.codexTicketModels}
              onChange={(event) => onChange({ codexTicketModels: event.target.value })}
              disabled={blocked}
              rows={3}
            />
            <span className={styles.muted}>{t('codex_turn_state.models_hint')}</span>
          </label>
          <Input
            label={t('codex_turn_state.harvest_proxy')}
            type="password"
            autoComplete="off"
            value={values.codexTicketHarvestProxy}
            onChange={(event) => onChange({ codexTicketHarvestProxy: event.target.value })}
            disabled={blocked}
            placeholder={t('codex_turn_state.proxy_placeholder')}
          />
          <p className={styles.muted}>{t('codex_turn_state.draft_hint')}</p>
        </div>
      ) : null}
    </ConfigSection>
  );
}
