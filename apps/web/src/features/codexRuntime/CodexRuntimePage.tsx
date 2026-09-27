import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useAuthStore } from '@/stores';
import { codexRuntimeApi, isCodexRuntimeUnsupported } from '@/services/api/codexRuntime';
import type { ApiClientRequestScope } from '@/services/api/client';
import type {
  CodexRuntimeLogin,
  CodexRuntimeLoginStatus,
  CodexRuntimeState,
} from '@/types/codexRuntime';
import { copyToClipboard } from '@/utils/clipboard';
import { isRecord } from '@/utils/helpers';
import {
  isCallbackURL,
  validateWorkers,
  workerDraft,
  workerPayload,
  type WorkerDraft,
} from './model';
import styles from './CodexRuntimePage.module.scss';

type Login = CodexRuntimeLogin & CodexRuntimeLoginStatus & { callback: string };

export function CodexRuntimePage() {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const scope = useMemo(() => ({ apiBase, managementKey }), [apiBase, managementKey]);
  return (
    <RuntimeSettings
      key={JSON.stringify([apiBase, managementKey, connected])}
      scope={scope}
      connected={connected}
    />
  );
}

function RuntimeSettings({
  scope,
  connected,
}: {
  scope: ApiClientRequestScope;
  connected: boolean;
}) {
  const { t } = useTranslation();
  const [runtime, setRuntime] = useState<CodexRuntimeState | null>(null);
  const [workers, setWorkers] = useState<WorkerDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [logins, setLogins] = useState<Record<string, Login>>({});
  const controller = useRef<AbortController | null>(null);
  const activeAction = useRef(false);
  const nextWorker = useRef(0);

  useEffect(() => {
    if (!connected) return;
    const request = new AbortController();
    controller.current = request;
    codexRuntimeApi
      .status(scope, request.signal)
      .then((result) => {
        if (request.signal.aborted) return;
        setRuntime(result);
        setWorkers(result.workers.map(workerDraft));
      })
      .catch((failure: unknown) => {
        if (request.signal.aborted) return;
        if (isCodexRuntimeUnsupported(failure)) setUnsupported(true);
        else setError('load_failed');
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy('');
      });
    return () => request.abort();
  }, [connected, scope]);

  const accept = (result: CodexRuntimeState, replaceDraft = false) => {
    setRuntime(result);
    if (!result.enabled) setLogins({});
    if (replaceDraft) {
      setWorkers(result.workers.map(workerDraft));
      setDirty(false);
    }
  };

  const run = async (action: string, operation: (signal: AbortSignal) => Promise<void>) => {
    const signal = controller.current?.signal;
    if (!connected || !signal || signal.aborted || activeAction.current) return;
    activeAction.current = true;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await operation(signal);
    } catch (failure) {
      if (signal.aborted) return;
      if (isCodexRuntimeUnsupported(failure)) {
        setUnsupported(true);
        setLogins({});
      } else if (isRecord(failure) && failure.status === 409) {
        setError('state_changed');
        setLogins({});
        // Refresh only CPA's local state after a rejected runtime action.
        try {
          const result = await codexRuntimeApi.status(scope, signal);
          if (!signal.aborted) accept(result);
        } catch {
          if (!signal.aborted) setRuntime(null);
        }
      } else setError('action_failed');
    } finally {
      activeAction.current = false;
      if (!signal.aborted) setBusy('');
    }
  };

  const refresh = () =>
    run('load', async (signal) => {
      const result = await codexRuntimeApi.status(scope, signal);
      if (!signal.aborted) {
        accept(result, true);
        setUnsupported(false);
      }
    });
  const changeWorker = (key: string, patch: Partial<WorkerDraft>) => {
    setWorkers((current) =>
      current.map((worker) => (worker.key === key ? { ...worker, ...patch } : worker))
    );
    setDirty(true);
    setLogins({});
  };
  const validation = validateWorkers(workers);
  const blocked = Boolean(busy) || !runtime || unsupported;

  const saveWorkers = () => {
    if (blocked || validation) return;
    void run('save', async (signal) => {
      const result = await codexRuntimeApi.update(
        { workers: workerPayload(workers) },
        scope,
        signal
      );
      if (!signal.aborted) {
        accept(result, true);
        setNotice('saved');
        setLogins({});
      }
    });
  };
  const setEnabled = (enabled: boolean) => {
    if (blocked) return;
    setLogins({});
    void run('switch', async (signal) => {
      const result = await codexRuntimeApi.update({ enabled }, scope, signal);
      if (!signal.aborted) {
        accept(result);
        setNotice('saved');
      }
    });
  };
  const networkAllowed = (worker: WorkerDraft) =>
    !blocked && runtime?.enabled && !worker.disabled && worker.saved && !dirty;
  const applyLoginStatus = (id: string, result: CodexRuntimeLoginStatus) => {
    setLogins((current) =>
      current[id]
        ? {
            ...current,
            [id]: {
              ...current[id],
              status: result.status,
              error: result.error,
              callback: result.status === 'pending' ? current[id].callback : '',
            },
          }
        : current
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>{t('codex_runtime.title')}</h1>
          <p className={styles.description}>{t('codex_runtime.description')}</p>
        </div>
        <Button
          variant="secondary"
          disabled={!connected || Boolean(busy) || dirty}
          loading={connected && busy === 'load'}
          onClick={() => void refresh()}
        >
          {t('common.refresh')}
        </Button>
      </div>
      {!connected ? (
        <p>{t('notification.connection_required')}</p>
      ) : (
        <>
          {error && (
            <p className={styles.error} role="alert">
              {t(`codex_runtime.${error}`)}
            </p>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {t(`codex_runtime.${notice}`)}
            </p>
          )}
          {unsupported ? (
            <Card>
              <p>{t('codex_runtime.unsupported')}</p>
            </Card>
          ) : runtime ? (
            <>
              <Card>
                <div className={styles.toggle}>
                  <div>
                    <strong>{t('codex_runtime.enabled')}</strong>
                    <p className={styles.muted}>{t('codex_runtime.enabled_hint')}</p>
                  </div>
                  <ToggleSwitch
                    checked={runtime.enabled}
                    onChange={setEnabled}
                    disabled={blocked}
                    ariaLabel={t('codex_runtime.enabled')}
                  />
                </div>
              </Card>
              {!runtime.enabled && <p className={styles.notice}>{t('codex_runtime.off_hint')}</p>}
              <Card
                title={t('codex_runtime.workers')}
                extra={
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={blocked}
                    onClick={() => {
                      setWorkers((current) => [
                        ...current,
                        {
                          key: `new-${++nextWorker.current}`,
                          id: '',
                          url: `ws://127.0.0.1:${38317 + current.length}/cpa/v1/ws`,
                          authFile: '',
                          token: '',
                          models: '',
                          saved: false,
                          disabled: false,
                        },
                      ]);
                      setDirty(true);
                      setLogins({});
                    }}
                  >
                    {t('codex_runtime.add_worker')}
                  </Button>
                }
              >
                <div className={styles.content}>
                  <p className={styles.muted}>{t('codex_runtime.worker_hint')}</p>
                  {workers.length === 0 && (
                    <p className={styles.muted}>{t('codex_runtime.no_workers')}</p>
                  )}
                  {workers.map((worker, index) => {
                    const savedWorker = runtime.workers.find((item) => item.id === worker.id);
                    const login = logins[worker.key];
                    const canNetwork = networkAllowed(worker);
                    return (
                      <section
                        key={worker.key}
                        className={styles.worker}
                        aria-label={worker.id || t('codex_runtime.new_worker')}
                      >
                        <div className={styles.workerHeader}>
                          <h3>{worker.id || t('codex_runtime.new_worker')}</h3>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={blocked}
                            onClick={() => {
                              setWorkers((current) =>
                                current.filter((item) => item.key !== worker.key)
                              );
                              setDirty(true);
                              setLogins({});
                            }}
                          >
                            {t('common.delete')}
                          </Button>
                        </div>
                        <div className={styles.grid}>
                          <Input
                            label={t('codex_runtime.worker_id')}
                            value={worker.id}
                            disabled={blocked || worker.saved}
                            onChange={(event) =>
                              changeWorker(worker.key, { id: event.target.value })
                            }
                            autoComplete="off"
                          />
                          <Input
                            label={t('codex_runtime.url')}
                            value={worker.url}
                            disabled={blocked}
                            placeholder={`ws://127.0.0.1:${38317 + index}/cpa/v1/ws`}
                            onChange={(event) =>
                              changeWorker(worker.key, { url: event.target.value })
                            }
                            autoComplete="off"
                          />
                          <Input
                            label={t('codex_runtime.auth_file')}
                            value={worker.authFile}
                            disabled={blocked || worker.saved}
                            placeholder="codex-worker.json"
                            hint={t('codex_runtime.auth_file_hint')}
                            onChange={(event) =>
                              changeWorker(worker.key, { authFile: event.target.value })
                            }
                            autoComplete="off"
                          />
                          <Input
                            label={t('codex_runtime.token')}
                            type="password"
                            value={worker.token}
                            disabled={blocked}
                            autoComplete="new-password"
                            placeholder={t(
                              savedWorker?.token_configured
                                ? 'codex_runtime.token_configured'
                                : 'codex_runtime.token_missing'
                            )}
                            hint={t('codex_runtime.token_hint')}
                            onChange={(event) =>
                              changeWorker(worker.key, { token: event.target.value })
                            }
                          />
                          <label className={styles.field}>
                            <span>{t('codex_runtime.models')}</span>
                            <textarea
                              className="input"
                              rows={3}
                              value={worker.models}
                              disabled={blocked}
                              onChange={(event) =>
                                changeWorker(worker.key, { models: event.target.value })
                              }
                            />
                            <span className={styles.muted}>{t('codex_runtime.models_hint')}</span>
                          </label>
                          <div className={styles.toggle}>
                            <span>{t('codex_runtime.worker_enabled')}</span>
                            <ToggleSwitch
                              checked={!worker.disabled}
                              disabled={blocked}
                              ariaLabel={t('codex_runtime.worker_enabled')}
                              onChange={(value) => changeWorker(worker.key, { disabled: !value })}
                            />
                          </div>
                        </div>
                        <div className={styles.actions}>
                          <Button
                            variant="secondary"
                            disabled={!canNetwork}
                            loading={busy === `test:${worker.key}`}
                            onClick={() => {
                              if (!networkAllowed(worker)) return;
                              void run(`test:${worker.key}`, async (signal) => {
                                await codexRuntimeApi.test(worker.id, scope, signal);
                                if (!signal.aborted) setNotice('test_ok');
                              });
                            }}
                          >
                            {t('codex_runtime.test')}
                          </Button>
                          <Button
                            disabled={!canNetwork}
                            loading={busy === `login:${worker.key}`}
                            onClick={() => {
                              if (!networkAllowed(worker)) return;
                              void run(`login:${worker.key}`, async (signal) => {
                                const result = await codexRuntimeApi.startLogin(
                                  worker.id,
                                  scope,
                                  signal
                                );
                                if (signal.aborted) return;
                                setLogins((current) => ({
                                  ...current,
                                  [worker.key]: { ...result, status: 'pending', callback: '' },
                                }));
                                const state = await codexRuntimeApi.status(scope, signal);
                                if (!signal.aborted) accept(state);
                              });
                            }}
                          >
                            {t('codex_runtime.authorize')}
                          </Button>
                        </div>
                        {login && runtime.enabled && !dirty && (
                          <div className={styles.login}>
                            {login.status === 'pending' && (
                              <>
                                <p className={styles.muted}>{t('codex_runtime.login_hint')}</p>
                                <a
                                  href={login.url}
                                  className={styles.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {login.url}
                                </a>
                                <div className={styles.actions}>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={blocked}
                                    onClick={() =>
                                      void run('copy', async (signal) => {
                                        const copied = await copyToClipboard(login.url);
                                        if (!signal.aborted) {
                                          if (copied) setNotice('copied');
                                          else setError('copy_failed');
                                        }
                                      })
                                    }
                                  >
                                    {t('codex_runtime.copy_url')}
                                  </Button>
                                </div>
                                <Input
                                  label={t('codex_runtime.callback')}
                                  value={login.callback}
                                  disabled={blocked}
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder="http://localhost:1455/auth/callback?code=…&state=…"
                                  onChange={(event) =>
                                    setLogins((current) => ({
                                      ...current,
                                      [worker.key]: { ...login, callback: event.target.value },
                                    }))
                                  }
                                  hint={t('codex_runtime.callback_hint')}
                                />
                                <div className={styles.actions}>
                                  <Button
                                    disabled={!canNetwork || !isCallbackURL(login.callback)}
                                    loading={busy === `callback:${worker.key}`}
                                    onClick={() => {
                                      if (!networkAllowed(worker) || !isCallbackURL(login.callback))
                                        return;
                                      void run(`callback:${worker.key}`, async (signal) => {
                                        const result = await codexRuntimeApi.submitCallback(
                                          worker.id,
                                          login.login_id,
                                          login.callback.trim(),
                                          scope,
                                          signal
                                        );
                                        if (signal.aborted) return;
                                        applyLoginStatus(worker.key, result);
                                        const state = await codexRuntimeApi.status(scope, signal);
                                        if (!signal.aborted) accept(state);
                                      });
                                    }}
                                  >
                                    {t('codex_runtime.submit_callback')}
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    disabled={!canNetwork}
                                    onClick={() => {
                                      if (!networkAllowed(worker)) return;
                                      void run(`status:${worker.key}`, async (signal) => {
                                        const result = await codexRuntimeApi.loginStatus(
                                          worker.id,
                                          login.login_id,
                                          scope,
                                          signal
                                        );
                                        if (signal.aborted) return;
                                        applyLoginStatus(worker.key, result);
                                        if (result.status === 'completed') {
                                          const state = await codexRuntimeApi.status(scope, signal);
                                          if (!signal.aborted) accept(state);
                                        }
                                      });
                                    }}
                                  >
                                    {t('codex_runtime.check_login')}
                                  </Button>
                                </div>
                              </>
                            )}
                            <p
                              role="status"
                              className={login.status === 'error' ? styles.error : styles.muted}
                            >
                              {t(`codex_runtime.login_${login.status}`)}
                            </p>
                            {login.status === 'error' && login.error && (
                              <p className={styles.error}>{login.error}</p>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}
                  {dirty && (
                    <>
                      <p className={styles.muted}>{t('codex_runtime.unsaved')}</p>
                      {validation && (
                        <p role="alert" className={styles.error}>
                          {t(`codex_runtime.${validation}`)}
                        </p>
                      )}
                      <div className={styles.saveActions}>
                        <Button
                          variant="secondary"
                          disabled={blocked}
                          onClick={() => {
                            setWorkers(runtime.workers.map(workerDraft));
                            setDirty(false);
                          }}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          disabled={blocked || Boolean(validation)}
                          loading={busy === 'save'}
                          onClick={saveWorkers}
                        >
                          {t('codex_runtime.save_workers')}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </Card>
              <Card title={t('codex_runtime.credentials')}>
                <div className={styles.content}>
                  <p className={styles.muted}>{t('codex_runtime.credentials_hint')}</p>
                  {runtime.credentials.length === 0 && (
                    <p className={styles.muted}>{t('codex_runtime.no_credentials')}</p>
                  )}
                  {runtime.credentials.map((credential) => {
                    const worker = runtime.workers.find(
                      (item) => item.auth_file === credential.name
                    );
                    return (
                      <div className={styles.credential} key={credential.name}>
                        <div className={styles.toggle}>
                          <strong>{credential.name}</strong>
                          <ToggleSwitch
                            checked={credential.enabled}
                            disabled={
                              blocked || dirty || !worker || credential.status === 'missing'
                            }
                            ariaLabel={t('codex_runtime.credential_enabled', {
                              name: credential.name,
                            })}
                            onChange={(enabled) => {
                              if (blocked || dirty || !worker || credential.status === 'missing')
                                return;
                              void run(`credential:${credential.name}`, async (signal) => {
                                const result = await codexRuntimeApi.setCredential(
                                  {
                                    name: credential.name,
                                    worker_id: worker?.id || credential.worker_id,
                                    enabled,
                                  },
                                  scope,
                                  signal
                                );
                                if (!signal.aborted) accept(result);
                              });
                            }}
                          />
                        </div>
                        <div className={styles.meta}>
                          <span>
                            {t('codex_runtime.worker_id')}:{' '}
                            {worker?.id || credential.worker_id || '—'}
                          </span>
                          <span>
                            {t('codex_runtime.owner')}:{' '}
                            {credential.owner === 'codex' ? 'Codex' : 'CPA'}
                          </span>
                          <span>
                            {t('codex_runtime.status')}:{' '}
                            {t(`codex_runtime.credential_status.${credential.status}`, {
                              defaultValue: credential.status || '—',
                            })}
                          </span>
                          {credential.account_id && (
                            <span>
                              {t('codex_runtime.account_id')}: {credential.account_id}
                            </span>
                          )}
                        </div>
                        {!worker && <p className={styles.muted}>{t('codex_runtime.unassigned')}</p>}
                        {credential.status === 'missing' && (
                          <p className={styles.muted}>{t('codex_runtime.missing_hint')}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            </>
          ) : busy === 'load' ? (
            <p>{t('config_management.status_loading')}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
