import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { apiClient, type ApiClientRequestScope } from '@/services/api/client';
import { resolveSiwcCredential, siwcCredentialIdentity } from '@/services/api/siwc';
import type { AuthFileItem } from '@/types';
import styles from '@/features/accounts/AccountsPage.module.scss';

export function SiwcCredentialToggle({
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
  const key = JSON.stringify([apiBase, managementKey, siwcCredentialIdentity(file)]);
  const [loaded, setLoaded] = useState<{ key: string; bound: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void resolveSiwcCredential({ apiBase, managementKey }, file, controller.signal)
      .then(({ file: verified }) => {
        if (!controller.signal.aborted) setLoaded({ key, bound: verified.siwc_bound === true });
      })
      .catch(() => {
        /* Unsupported CPA or unverified identity: do not offer a writable switch. */
      });
    return () => controller.abort();
  }, [apiBase, managementKey, file, key]);
  if (loaded?.key !== key) return null;
  return (
    <div className={styles.configurationToggleRow}>
      <div>
        <strong>{t('siwc.use')}</strong>
        <p>{t(loaded.bound ? 'siwc.use_hint' : 'siwc.bind_first')}</p>
      </div>
      <ToggleSwitch
        checked={checked}
        onChange={onChange}
        disabled={disabled || (!loaded.bound && !checked)}
        ariaLabel={t('siwc.use')}
      />
    </div>
  );
}
