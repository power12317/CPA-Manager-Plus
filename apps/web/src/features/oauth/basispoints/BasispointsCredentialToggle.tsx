import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { apiClient, type ApiClientRequestScope } from '@/services/api/client';
import {
  basispointsApi,
  basispointsCredentialIdentity,
  resolveBasispointsCredential,
  type BasispointsBindingStatus,
} from '@/services/api/basispoints';
import type { AuthFileItem } from '@/types';
import styles from '@/features/accounts/AccountsPage.module.scss';

export function BasispointsCredentialToggle({
  file,
  requestScope,
  checked,
  disabled,
  onChange,
}: {
  file: AuthFileItem;
  requestScope?: ApiClientRequestScope;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const { apiBase, managementKey } = requestScope ?? apiClient.getRequestScope();
  const key = JSON.stringify([apiBase, managementKey, basispointsCredentialIdentity(file)]);
  const [loaded, setLoaded] = useState<{
    key: string;
    status: BasispointsBindingStatus | null;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void resolveBasispointsCredential({ apiBase, managementKey }, file, controller.signal)
      .then(async (verified) => {
        const status = await basispointsApi.bindingStatus(
          verified.scope,
          verified.file,
          controller.signal
        );
        if (!controller.signal.aborted) setLoaded({ key, status });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, status: null });
      });
    return () => controller.abort();
  }, [apiBase, managementKey, file, key]);
  const status = loaded?.key === key ? loaded.status : null;
  const valid =
    status?.bind_supported === true && status.bound === true && status.status === 'valid';
  const supported = status?.bind_supported === true;
  return (
    <div className={styles.configurationToggleRow}>
      <div>
        <strong>{t('basispoints.use')}</strong>
        <p>
          {t(
            !supported
              ? 'basispoints.unsupported'
              : valid
                ? 'basispoints.use_hint'
                : 'basispoints.bind_first'
          )}
        </p>
        {supported && status ? (
          <p role="status">
            {t(
              `basispoints.status_${status.status === 'valid' || status.status === 'invalid' ? status.status : 'off'}`
            )}
          </p>
        ) : null}
      </div>
      <ToggleSwitch
        checked={checked}
        onChange={onChange}
        disabled={disabled || !supported || (!valid && !checked)}
        ariaLabel={t('basispoints.use')}
      />
    </div>
  );
}
