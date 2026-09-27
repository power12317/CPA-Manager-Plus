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
  CodexRuntimeCredential,
  CodexRuntimeLogin,
  CodexRuntimeLoginStatus,
  CodexRuntimeState,
} from '@/types/codexRuntime';
import { copyToClipboard } from '@/utils/clipboard';
import { getErrorMessage, isRecord } from '@/utils/helpers';
import { isCallbackURL } from './model';
import styles from './CodexRuntimePage.module.scss';

type Login = CodexRuntimeLogin & CodexRuntimeLoginStatus & { callback: string; label?: string };
type PageError = { key: string; detail?: string };

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
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState<PageError | null>(null);
  const [notice, setNotice] = useState('');
  const [login, setLogin] = useState<Login | null>(null);
  const controller = useRef<AbortController | null>(null);
  const activeAction = useRef(false);

  useEffect(() => {
    if (!connected) return;
    const request = new AbortController();
    controller.current = request;
    codexRuntimeApi
      .status(scope, request.signal)
      .then((result) => {
        if (!request.signal.aborted) setRuntime(result);
      })
      .catch((failure: unknown) => {
        if (request.signal.aborted) return;
        if (isCodexRuntimeUnsupported(failure)) setUnsupported(true);
        else setError({ key: 'load_failed' });
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy('');
      });
    return () => request.abort();
  }, [connected, scope]);

  const accept = (result: CodexRuntimeState) => {
    setRuntime(result);
    if (!result.enabled) setLogin(null);
  };
  const readLocalState = async (signal: AbortSignal) => {
    const result = await codexRuntimeApi.status(scope, signal);
    if (!signal.aborted) accept(result);
  };
  const run = async (action: string, operation: (signal: AbortSignal) => Promise<void>) => {
    const signal = controller.current?.signal;
    if (!connected || !signal || signal.aborted || activeAction.current) return;
    activeAction.current = true;
    setBusy(action);
    setError(null);
    setNotice('');
    try {
      await operation(signal);
    } catch (failure) {
      if (signal.aborted) return;
      if (isCodexRuntimeUnsupported(failure)) {
        setUnsupported(true);
        setLogin(null);
      } else if (isRecord(failure) && failure.status === 409) {
        setError({ key: 'state_changed' });
        setLogin(null);
        try {
          await readLocalState(signal);
        } catch {
          if (!signal.aborted) setRuntime(null);
        }
      } else {
        setError({ key: 'action_failed', detail: getErrorMessage(failure, '') });
      }
    } finally {
      activeAction.current = false;
      if (!signal.aborted) setBusy('');
    }
  };

  const blocked = Boolean(busy) || !runtime || unsupported;
  const canAuthorize = !blocked && runtime?.enabled === true;
  const setEnabled = (enabled: boolean) => {
    if (blocked) return;
    setLogin(null);
    void run('switch', async (signal) => {
      const result = await codexRuntimeApi.update({ enabled }, scope, signal);
      if (!signal.aborted) {
        accept(result);
        setNotice('saved');
      }
    });
  };
  const startLogin = (credential?: CodexRuntimeCredential) => {
    if (!canAuthorize) return;
    setLogin(null);
    void run('login', async (signal) => {
      const result = await codexRuntimeApi.startLogin(
        credential ? { name: credential.name } : {},
        scope,
        signal
      );
      if (signal.aborted) return;
      setLogin({ ...result, status: 'pending', callback: '', label: credential?.label });
      await readLocalState(signal);
    });
  };
  const applyLoginStatus = (id: string, result: CodexRuntimeLoginStatus) => {
    setLogin((current) =>
      current?.login_id === id
        ? {
            ...current,
            status: result.status,
            error: result.error,
            callback: result.status === 'pending' ? current.callback : '',
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
          disabled={!connected || Boolean(busy)}
          loading={connected && busy === 'load'}
          onClick={() =>
            void run('load', async (signal) => {
              await readLocalState(signal);
              if (!signal.aborted) setUnsupported(false);
            })
          }
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
              {error.detail || t('codex_runtime.' + error.key)}
            </p>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {t('codex_runtime.' + notice)}
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
              <Card title={t('codex_runtime.authorization')}>
                <div className={styles.content}>
                  <div className={styles.actions}>
                    <Button
                      disabled={!canAuthorize}
                      loading={busy === 'login'}
                      onClick={() => startLogin()}
                    >
                      {t('codex_runtime.authorize')}
                    </Button>
                  </div>
                  {login && runtime.enabled && (
                    <div className={styles.login}>
                      {login.label && (
                        <p className={styles.muted}>
                          {t('codex_runtime.authorizing_account', { label: login.label })}
                        </p>
                      )}
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
                                    else setError({ key: 'copy_failed' });
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
                              setLogin({ ...login, callback: event.target.value })
                            }
                            hint={t('codex_runtime.callback_hint')}
                          />
                          <div className={styles.actions}>
                            <Button
                              disabled={!canAuthorize || !isCallbackURL(login.callback)}
                              loading={busy === 'callback'}
                              onClick={() => {
                                if (!canAuthorize || !isCallbackURL(login.callback)) return;
                                void run('callback', async (signal) => {
                                  const result = await codexRuntimeApi.submitCallback(
                                    login.login_id,
                                    login.callback.trim(),
                                    scope,
                                    signal
                                  );
                                  if (signal.aborted) return;
                                  applyLoginStatus(login.login_id, result);
                                  await readLocalState(signal);
                                });
                              }}
                            >
                              {t('codex_runtime.submit_callback')}
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={!canAuthorize}
                              onClick={() => {
                                if (!canAuthorize) return;
                                void run('status', async (signal) => {
                                  const result = await codexRuntimeApi.loginStatus(
                                    login.login_id,
                                    scope,
                                    signal
                                  );
                                  if (signal.aborted) return;
                                  applyLoginStatus(login.login_id, result);
                                  if (result.status === 'completed') await readLocalState(signal);
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
                        {t('codex_runtime.login_' + login.status)}
                      </p>
                      {login.status === 'error' && login.error && (
                        <p className={styles.error}>{login.error}</p>
                      )}
                    </div>
                  )}
                </div>
              </Card>
              <Card title={t('codex_runtime.credentials')}>
                <div className={styles.content}>
                  <p className={styles.muted}>{t('codex_runtime.credentials_hint')}</p>
                  {runtime.credentials.length === 0 && (
                    <p className={styles.muted}>{t('codex_runtime.no_credentials')}</p>
                  )}
                  {runtime.credentials.map((credential) => (
                    <div className={styles.credential} key={credential.name}>
                      <div>
                        <strong>{credential.label}</strong>
                        <p className={styles.muted}>
                          {t('codex_runtime.credential_status.' + credential.status, {
                            defaultValue: credential.status,
                          })}
                        </p>
                      </div>
                      <div className={styles.actions}>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!canAuthorize}
                          aria-label={t('codex_runtime.reauthorize_account', {
                            label: credential.label,
                          })}
                          onClick={() => startLogin(credential)}
                        >
                          {t('codex_runtime.reauthorize')}
                        </Button>
                        <ToggleSwitch
                          checked={credential.enabled}
                          disabled={blocked || credential.status === 'missing'}
                          ariaLabel={t('codex_runtime.credential_enabled', {
                            name: credential.label,
                          })}
                          onChange={(enabled) => {
                            if (blocked || credential.status === 'missing') return;
                            void run('credential', async (signal) => {
                              const result = await codexRuntimeApi.setCredential(
                                { name: credential.name, enabled },
                                scope,
                                signal
                              );
                              if (!signal.aborted) accept(result);
                            });
                          }}
                        />
                      </div>
                    </div>
                  ))}
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
