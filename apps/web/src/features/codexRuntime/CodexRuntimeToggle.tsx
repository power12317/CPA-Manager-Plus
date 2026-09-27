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
  onOperationStart: (mayChangeConfig: boolean) => boolean;
  onOperationEnd: (mayChangeConfig: boolean) => Promise<void>;
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
  onOperationStart,
  onOperationEnd,
}: CodexRuntimeToggleProps & { scope: ApiClientRequestScope }) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const activeAction = useRef(false);

  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    codexRuntimeApi
      .status(scope, request.signal)
      .then((result) => {
        if (!request.signal.aborted) setEnabled(result.enabled);
      })
      .catch((failure: unknown) => {
        if (!request.signal.aborted && !isCodexRuntimeUnsupported(failure)) {
          showNotification(t('codex_runtime.load_failed'), 'error');
        }
      });
    return () => request.abort();
  }, [scope, showNotification, t]);

  const updateMode = async (nextEnabled: boolean) => {
    const signal = controller.current?.signal;
    if (disabled || enabled === null || !signal || signal.aborted || activeAction.current) return;
    if (!onOperationStart(true)) return;
    activeAction.current = true;
    setSaving(true);
    try {
      const result = await codexRuntimeApi.update({ enabled: nextEnabled }, scope, signal);
      if (!signal.aborted) {
        setEnabled(result.enabled);
        showNotification(t('codex_runtime.saved'), 'success');
      }
    } catch (failure) {
      if (signal.aborted) return;
      if (isCodexRuntimeUnsupported(failure)) {
        setEnabled(null);
      } else {
        showNotification(t('codex_runtime.action_failed'), 'error');
        // A lost response can follow a successful write. Reconcile before retrying.
        try {
          const result = await codexRuntimeApi.status(scope, signal);
          if (!signal.aborted) setEnabled(result.enabled);
        } catch {
          if (!signal.aborted) setEnabled(null);
        }
      }
    } finally {
      await onOperationEnd(true);
      activeAction.current = false;
      if (!signal.aborted) setSaving(false);
    }
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
        disabled={disabled || saving}
        ariaLabel={t('codex_runtime.enabled')}
      />
    </div>
  );
}
