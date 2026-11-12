import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import type { AuthFileItem } from '@/types';
import type { ApiClientRequestScope } from '@/services/api/client';
import {
  basispointsApi,
  resolveBasispointsCredential,
  basispointsCredentialIdentity,
  supportsBasispointsBinding,
  type BasispointsSession,
} from '@/services/api/basispoints';
import { copyToClipboard } from '@/utils/clipboard';
import { createSiwcStart as createBindingStart } from '../siwc/bindingModel';
import {
  isBasispointsCallbackValid,
  isBasispointsSessionValid,
  OFFICE_CALLBACK,
} from './bindingModel';
import styles from '../siwc/SiwcBindDialog.module.scss';

type Phase =
  | 'loading'
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'verifying'
  | 'verify-error'
  | 'success'
  | 'error';
type Props = {
  requestScope: ApiClientRequestScope;
  file?: AuthFileItem;
  onClose: () => void;
  onBound?: () => void;
};

// A scope change unmounts the entire flow, cancelling only its original CPA.
export function BasispointsBindDialog(props: Props) {
  return (
    <BindingSession
      key={JSON.stringify([
        props.requestScope.apiBase,
        props.requestScope.managementKey,
        props.file ? basispointsCredentialIdentity(props.file) : '',
      ])}
      {...props}
    />
  );
}

function BindingSession({
  requestScope: incomingScope,
  file: incomingFile,
  onClose,
  onBound,
}: Props) {
  const [{ requestScope, file }] = useState(() => ({
    requestScope: incomingScope,
    file: incomingFile,
  }));
  const { t } = useTranslation();
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [target, setTarget] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<BasispointsSession | null>(null);
  const [callback, setCallback] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const alive = useRef(false);
  const controller = useRef(new AbortController());
  const startup = useRef<ReturnType<typeof createBindingStart<BasispointsSession>> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = useRef<{ scope: ApiClientRequestScope; file: AuthFileItem } | null>(null);
  const deadline = useRef(0);
  const terminal = useRef(false);
  const loadedScope = useRef(requestScope);

  useEffect(() => {
    alive.current = true;
    const request = new AbortController();
    controller.current = request;
    const load = file
      ? resolveBasispointsCredential(requestScope, file, request.signal).then((resolved) => {
          loadedScope.current = resolved.scope;
          return [resolved.file];
        })
      : basispointsApi.list(requestScope, request.signal);
    void load
      .then((records) => {
        if (request.signal.aborted) return;
        const targets = records
          .filter(supportsBasispointsBinding)
          .sort((a, b) => a.name.localeCompare(b.name));
        setFiles(targets);
        if (targets.length === 1) setTarget(basispointsCredentialIdentity(targets[0]));
        setPhase('idle');
      })
      .catch(() => {
        if (request.signal.aborted) return;
        setPhase('error');
        setMessage('basispoints.unsupported');
      });
    return () => {
      alive.current = false;
      request.abort();
      if (timer.current) clearTimeout(timer.current);
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
      startup.current?.close();
    };
  }, [requestScope, file]);

  const fail = (key: string) => {
    terminal.current = true;
    startup.current?.close();
    if (timer.current) clearTimeout(timer.current);
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    setCallback('');
    setSession(null);
    setPhase('error');
    setMessage(key);
  };

  const verifyBinding = async () => {
    const captured = selected.current;
    if (!captured || !alive.current) return;
    setPhase('verifying');
    try {
      const verified = await resolveBasispointsCredential(
        captured.scope,
        captured.file,
        controller.current.signal
      );
      const status = await basispointsApi.bindingStatus(
        verified.scope,
        verified.file,
        controller.current.signal
      );
      if (!alive.current) return;
      if (
        !status.bind_supported ||
        !status.bound ||
        status.status !== 'valid' ||
        status.use_basispoints !== true ||
        verified.file.basispoints_bound !== true ||
        verified.file.use_basispoints !== true
      )
        throw new Error('Binding not confirmed');
      setPhase('success');
      setMessage('basispoints.success');
    } catch {
      if (!alive.current) return;
      setPhase('verify-error');
      setMessage('basispoints.readback_failed');
    }
  };

  const poll = async (current: BasispointsSession) => {
    if (!alive.current || terminal.current || !selected.current) return;
    if (Date.now() >= deadline.current) {
      fail('basispoints.expired');
      return;
    }
    try {
      const result = await basispointsApi.status(
        selected.current.scope,
        current.state,
        controller.current.signal
      );
      if (!alive.current || terminal.current) return;
      if (result.status === 'ok') {
        terminal.current = true;
        startup.current?.complete();
        if (expiryTimer.current) clearTimeout(expiryTimer.current);
        setCallback('');
        setSession(null);
        await verifyBinding();
        return;
      }
      if (result.status !== 'wait') {
        fail('basispoints.failed');
        return;
      }
    } catch {
      if (!alive.current || terminal.current) return;
      setMessage('basispoints.status_retry');
    }
    timer.current = setTimeout(() => void poll(current), 2000);
  };

  const start = async () => {
    if (phase !== 'idle' || startup.current) return;
    const targetFile = files.find((entry) => basispointsCredentialIdentity(entry) === target);
    if (!targetFile) return;
    setPhase('starting');
    setMessage('');
    const capturedScope = loadedScope.current;
    let sessionScope = capturedScope;
    const attempt = createBindingStart({
      start: async () => {
        const verified = await resolveBasispointsCredential(
          capturedScope,
          targetFile,
          controller.current.signal
        );
        if (!alive.current) throw new Error('Binding closed');
        selected.current = verified;
        sessionScope = verified.scope;
        return basispointsApi.start(verified.scope, verified.file);
      },
      cancel: (state) => basispointsApi.cancel(sessionScope, state),
      onResult: (result) => {
        if (!alive.current) return;
        if (!isBasispointsSessionValid(result)) {
          fail('basispoints.failed');
          return;
        }
        const lifetime = Math.min(result.expires_in ?? 300, 300) * 1000;
        deadline.current = Date.now() + lifetime;
        expiryTimer.current = setTimeout(() => {
          if (alive.current && !terminal.current) fail('basispoints.expired');
        }, lifetime);
        setSession(result);
        setPhase('waiting');
        void poll(result);
      },
      onError: () => {
        if (alive.current) fail('basispoints.failed');
      },
    });
    startup.current = attempt;
    await attempt.start();
  };

  const submit = async () => {
    const captured = selected.current;
    if (!session || !captured || phase !== 'waiting' || submitting || terminal.current) return;
    if (Date.now() >= deadline.current) {
      fail('basispoints.expired');
      return;
    }
    if (!isBasispointsCallbackValid(callback, session.state)) {
      setMessage('basispoints.invalid_callback');
      return;
    }
    setSubmitting(true);
    try {
      await resolveBasispointsCredential(captured.scope, captured.file, controller.current.signal);
      if (!alive.current || terminal.current) return;
      await basispointsApi.callback(
        captured.scope,
        session.state,
        callback.trim(),
        controller.current.signal
      );
      if (alive.current && !terminal.current) setMessage('basispoints.submitted');
    } catch {
      if (alive.current && !terminal.current) setMessage('basispoints.callback_failed');
    } finally {
      if (alive.current) {
        setCallback('');
        setSubmitting(false);
      }
    }
  };

  const close = () => {
    startup.current?.close();
    if (phase === 'success') onBound?.();
    onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      title={t('basispoints.title')}
      width={560}
      footer={
        <Button variant="secondary" onClick={close}>
          {t(phase === 'success' ? 'common.close' : 'common.cancel')}
        </Button>
      }
    >
      <div className={styles.content}>
        <p>{t('basispoints.intro')}</p>
        {phase === 'loading' ? <p role="status">{t('basispoints.loading')}</p> : null}
        {phase === 'idle' ? (
          <>
            <Select
              value={target}
              onChange={setTarget}
              ariaLabel={t('basispoints.target')}
              options={files.map((entry) => ({
                value: basispointsCredentialIdentity(entry),
                label: entry.name,
              }))}
              placeholder={t('basispoints.target')}
              fullWidth
            />
            {!files.length ? <p>{t('basispoints.unsupported')}</p> : null}
            <Button disabled={!target} onClick={() => void start()}>
              {t('basispoints.start')}
            </Button>
          </>
        ) : null}
        {phase === 'starting' ? <p role="status">{t('basispoints.starting')}</p> : null}
        {session && phase === 'waiting' ? (
          <>
            <p>{selected.current?.file.name}</p>
            <Input label={t('basispoints.url')} value={session.url} readOnly />
            <div className={styles.actions}>
              <Button onClick={() => window.open(session.url, '_blank', 'noopener,noreferrer')}>
                {t('basispoints.open')}
              </Button>
              <Button variant="secondary" onClick={() => void copyToClipboard(session.url)}>
                {t('common.copy')}
              </Button>
            </div>
            <Input
              label={t('basispoints.callback')}
              type="password"
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
              placeholder={OFFICE_CALLBACK + '?code=…&state=…'}
              hint={t('basispoints.callback_hint')}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            <Button onClick={() => void submit()} disabled={!callback.trim()} loading={submitting}>
              {t('basispoints.submit')}
            </Button>
          </>
        ) : null}
        {phase === 'verifying' ? <p role="status">{t('basispoints.verifying')}</p> : null}
        {message ? <p role={phase === 'success' ? 'status' : 'alert'}>{t(message)}</p> : null}
        {phase === 'verify-error' ? (
          <Button onClick={() => void verifyBinding()}>{t('common.retry')}</Button>
        ) : null}
      </div>
    </Modal>
  );
}

export function BasispointsOAuthEntry({
  requestScope,
  file,
  disabled,
  onBound,
}: Omit<Props, 'onClose'> & { disabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const key = JSON.stringify([
    requestScope.apiBase,
    requestScope.managementKey,
    file ? basispointsCredentialIdentity(file) : '',
  ]);
  const [checked, setChecked] = useState<{
    key: string;
    supported: boolean;
    bound: boolean;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const check = file
      ? resolveBasispointsCredential(requestScope, file, controller.signal).then((resolved) => ({
          supported: true,
          bound: resolved.file.basispoints_bound === true,
        }))
      : basispointsApi
          .list(requestScope, controller.signal)
          .then((files) => ({ supported: files.some(supportsBasispointsBinding), bound: false }));
    void check
      .then((value) => {
        if (!controller.signal.aborted) setChecked({ key, ...value });
      })
      .catch(() => {
        if (!controller.signal.aborted) setChecked({ key, supported: false, bound: false });
      });
    return () => controller.abort();
  }, [requestScope, file, key]);
  const supported = checked?.key === key && checked.supported;
  const bound = checked?.key === key && checked.bound;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={disabled || !supported}
        title={!supported ? t('basispoints.unsupported') : undefined}
      >
        {t(bound ? 'basispoints.reauthorize' : 'basispoints.bind')}
      </Button>
      {open ? (
        <BasispointsBindDialog
          requestScope={requestScope}
          file={file}
          onClose={() => setOpen(false)}
          onBound={onBound}
        />
      ) : null}
    </>
  );
}
