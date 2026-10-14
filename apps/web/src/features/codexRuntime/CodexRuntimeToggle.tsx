import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useAuthStore, useNotificationStore } from '@/stores';
import { codexRuntimeApi, isCodexRuntimeUnsupported } from '@/services/api/codexRuntime';
import type { ApiClientRequestScope } from '@/services/api/client';
import { instanceIdFromBase } from '@/utils/instanceScope';
import styles from '@/components/config/VisualConfigEditor.module.scss';

interface CodexRuntimeToggleProps {
  disabled?: boolean;
  onLoaded?: (enabled: boolean) => void;
  onDraftChange?: (enabled: boolean) => void;
}

export function CodexRuntimeToggle(props: CodexRuntimeToggleProps) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const managerSession = useAuthStore((state) => state.sessionMode === 'manager_embedded');
  const scope = useMemo(() => ({ apiBase, managementKey }), [apiBase, managementKey]);
  if (!connected || !apiBase || (managerSession && !instanceIdFromBase(apiBase))) return null;
  return <RuntimeToggle key={JSON.stringify([apiBase, managementKey])} scope={scope} {...props} />;
}

function RuntimeToggle({
  scope,
  disabled = false,
  onLoaded,
  onDraftChange,
}: CodexRuntimeToggleProps & { scope: ApiClientRequestScope }) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    codexRuntimeApi
      .status(scope, request.signal)
      .then((result) => {
        if (!request.signal.aborted) {
          setEnabled(result.enabled);
          onLoaded?.(result.enabled);
        }
      })
      .catch((failure: unknown) => {
        if (!request.signal.aborted && !isCodexRuntimeUnsupported(failure)) {
          showNotification(t('codex_runtime.load_failed'), 'error');
        }
      });
    return () => request.abort();
  }, [onLoaded, scope, showNotification, t]);

  const updateMode = async (nextEnabled: boolean) => {
    const signal = controller.current?.signal;
    if (disabled || enabled === null || !signal || signal.aborted) return;
    setEnabled(nextEnabled);
    onDraftChange?.(nextEnabled);
  };

  if (enabled === null) return null;
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleCopy}>
        <div className={styles.toggleTitle}>{t('codex_runtime.enabled')}</div>
        <div className={styles.toggleDescription}>{t('codex_runtime.enabled_hint')}</div>
      </div>
      <ToggleSwitch
        checked={enabled}
        onChange={(value) => void updateMode(value)}
        disabled={disabled}
        ariaLabel={t('codex_runtime.enabled')}
      />
    </div>
  );
}
