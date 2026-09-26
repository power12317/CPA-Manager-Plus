import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { clusterApi, type CPAInstance } from '@/services/api/cluster';
import type { ApiClientRequestScope } from '@/services/api/client';
import {
  oailbBorrowApi,
  oailbBorrowErrorCode,
  type OailbBorrowCredential,
  type OailbBorrowStatus,
} from '@/services/api/oailbBorrow';
import { instanceIdFromBase } from '@/utils/instanceScope';
import styles from './CodexOailbBorrowSettings.module.scss';

interface Props {
  scope: ApiClientRequestScope;
  managerMode: boolean;
  disabled?: boolean;
  sourceDirty?: boolean;
  onOperationStart: () => void;
  onOperationEnd: () => void;
  onSaved: () => Promise<unknown>;
}

// Replacing the scope discards only this editor's requests and draft. It does
// not reload the page or change the shared manager/CPA client credentials.
export function CodexOailbBorrowSettings(props: Props) {
  return <OailbBorrowEditor key={props.scope.apiBase} {...props} />;
}

function OailbBorrowEditor({
  scope,
  managerMode,
  disabled = false,
  sourceDirty = false,
  onOperationStart,
  onOperationEnd,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const targetId = instanceIdFromBase(scope.apiBase);
  const api = useMemo(() => oailbBorrowApi(scope, targetId), [scope, targetId]);
  const registry = useMemo(() => clusterApi(scope.apiBase, scope.managementKey), [scope]);
  const lifecycle = useRef<AbortController | null>(null);
  const mutationInFlight = useRef(false);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<OailbBorrowStatus | null>(null);
  const [instances, setInstances] = useState<CPAInstance[]>([]);
  const [credentials, setCredentials] = useState<OailbBorrowCredential[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [authId, setAuthId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [credentialError, setCredentialError] = useState('');
  const [saved, setSaved] = useState(false);
  const labelId = useId();
  const hintId = `${labelId}-hint`;
  const sourceLabel = `${labelId}-source`;
  const authLabel = `${labelId}-auth`;

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    if (!managerMode || !targetId) return () => controller.abort();
    setLoading(true);
    setError('');
    setSaved(false);
    void (async () => {
      try {
        const next = await api.get(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        setSourceId(
          next.configured
            ? next.sourceInstanceId && next.sourceInstanceId !== targetId
              ? next.sourceInstanceId
              : 'unregistered-source'
            : ''
        );
        setAuthId(next.sourceAuthId || '');
        if (next.supported) {
          const list = await registry.list(controller.signal);
          if (!controller.signal.aborted) setInstances(list);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(oailbBorrowErrorCode(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [api, registry, managerMode, targetId, revision]);

  const availableSources = instances.filter(
    (item) => item.id !== targetId && item.enabled && item.ready
  );
  const sourceAvailable = availableSources.some((item) => item.id === sourceId);
  useEffect(() => {
    const controller = new AbortController();
    setCredentials([]);
    setCredentialError('');
    setLoadingCredentials(false);
    if (!managerMode || !status?.supported || !sourceId || !sourceAvailable)
      return () => controller.abort();
    setLoadingCredentials(true);
    void api
      .credentials(sourceId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setCredentials(items);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setCredentialError(oailbBorrowErrorCode(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCredentials(false);
      });
    return () => controller.abort();
  }, [api, managerMode, status?.supported, sourceId, sourceAvailable, revision]);

  const sourceOptions = [
    { value: '', label: t('config_management.oailb_borrow.none') },
    ...availableSources.map((item) => ({ value: item.id, label: item.name })),
  ];
  if (sourceId && !sourceAvailable) {
    sourceOptions.push({
      value: sourceId,
      label: t('config_management.oailb_borrow.missing_source', {
        name:
          instances.find((item) => item.id === sourceId)?.name ||
          t('config_management.oailb_borrow.saved_source'),
      }),
    });
  }
  const credentialSelected = credentials.some((item) => item.id === authId);
  const credentialOptions = [
    { value: '', label: t('config_management.oailb_borrow.choose_credential') },
    ...credentials.map((item) => ({ value: item.id, label: item.name })),
  ];
  if (
    authId &&
    !credentialSelected &&
    sourceId ===
      (status?.sourceInstanceId && status.sourceInstanceId !== targetId
        ? status.sourceInstanceId
        : 'unregistered-source')
  ) {
    credentialOptions.push({
      value: authId,
      label: status?.sourceAuthFile || t('config_management.oailb_borrow.saved_credential'),
    });
  }
  const canSave =
    !!status?.supported &&
    !loading &&
    !saving &&
    !disabled &&
    !sourceDirty &&
    (!sourceId ||
      (sourceAvailable && credentialSelected && !loadingCredentials && !credentialError));

  const save = async () => {
    const controller = lifecycle.current;
    if (!canSave || mutationInFlight.current || !controller || controller.signal.aborted) return;
    let locked = false;
    mutationInFlight.current = true;
    setError('');
    setSaved(false);
    try {
      onOperationStart();
      locked = true;
      setSaving(true);
      const next = await api.save(
        { sourceInstanceId: sourceId, sourceAuthId: sourceId ? authId : '' },
        controller.signal
      );
      if (controller.signal.aborted) return;
      setStatus(next);
      await onSaved();
      if (!controller.signal.aborted) setSaved(true);
    } catch (cause) {
      if (!controller.signal.aborted) setError(oailbBorrowErrorCode(cause));
    } finally {
      mutationInFlight.current = false;
      if (locked) onOperationEnd();
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  const unavailable = !managerMode
    ? 'manager_required'
    : !targetId
      ? 'instance_required'
      : status && !status.supported
        ? 'unsupported'
        : '';
  return (
    <section className={styles.settings} aria-labelledby={labelId} aria-describedby={hintId}>
      <strong id={labelId}>{t('config_management.oailb_borrow.title')}</strong>
      <p className={styles.description} id={hintId}>
        {t(`config_management.oailb_borrow.${unavailable || 'description'}`)}
      </p>
      {unavailable === 'unsupported' && (
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t('common.refresh')}
        </Button>
      )}
      {!unavailable && (
        <>
          {loading ? (
            <p role="status" className={styles.description}>
              {t('common.loading')}
            </p>
          ) : status?.supported ? (
            <div className={styles.fields}>
              <div className={styles.field}>
                <label id={sourceLabel}>{t('config_management.oailb_borrow.source')}</label>
                <Select
                  value={sourceId}
                  options={sourceOptions}
                  ariaLabelledBy={sourceLabel}
                  disabled={disabled || saving}
                  onChange={(value) => {
                    setSourceId(value);
                    setAuthId('');
                    setCredentials([]);
                    setSaved(false);
                  }}
                />
              </div>
              {sourceId && (
                <div className={styles.field}>
                  <label id={authLabel}>{t('config_management.oailb_borrow.credential')}</label>
                  <Select
                    value={authId}
                    options={credentialOptions}
                    ariaLabelledBy={authLabel}
                    disabled={disabled || saving || loadingCredentials || !sourceAvailable}
                    onChange={(value) => {
                      setAuthId(value);
                      setSaved(false);
                    }}
                  />
                  <span className={styles.description} role="status">
                    {loadingCredentials
                      ? t('common.loading')
                      : sourceAvailable && !credentialError && credentials.length === 0
                        ? t('config_management.oailb_borrow.no_credentials')
                        : null}
                  </span>
                </div>
              )}
            </div>
          ) : null}
          {sourceDirty && (
            <p className={styles.description}>{t('config_management.oailb_borrow.source_dirty')}</p>
          )}
          {(error || credentialError) && (
            <p className={styles.error} role="alert">
              {t(`config_management.oailb_borrow.${error || credentialError}`)}
            </p>
          )}
          {saved && (
            <p className={styles.description} role="status">
              {t('config_management.oailb_borrow.saved')}
            </p>
          )}
          <div className={styles.actions}>
            <Button size="sm" onClick={() => void save()} disabled={!canSave} loading={saving}>
              {t('config_management.oailb_borrow.save')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || loading || saving}
              onClick={() => setRevision((value) => value + 1)}
            >
              {t('common.refresh')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
