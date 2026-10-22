import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import type { AuthFileItem } from '@/types';
import type { ApiClientRequestScope } from '@/services/api/client';
import {
  siwcApi,
  resolveSiwcCredential,
  siwcCredentialIdentity,
  supportsSiwcBinding,
  type SiwcSession,
} from '@/services/api/siwc';
import { copyToClipboard } from '@/utils/clipboard';
import { createSiwcStart, isSiwcCallbackValid } from './bindingModel';
import styles from './SiwcBindDialog.module.scss';

type Phase =
  | 'loading'
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'verifying'
  | 'verify-error'
  | 'success'
  | 'error';

export function SiwcBindDialog({
  requestScope,
  onClose,
}: {
  requestScope: ApiClientRequestScope;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [target, setTarget] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<SiwcSession | null>(null);
  const [callback, setCallback] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const alive = useRef(false);
  const controller = useRef(new AbortController());
  const startup = useRef<ReturnType<typeof createSiwcStart<SiwcSession>> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = useRef<AuthFileItem | null>(null);
  const deadline = useRef(0);
  const activeSession = useRef<SiwcSession | null>(null);
  const terminal = useRef(false);

  useEffect(() => {
    alive.current = true;
    const request = new AbortController();
    controller.current = request;
    void siwcApi
      .list(requestScope, request.signal)
      .then((records) => {
        if (!alive.current || request.signal.aborted) return;
        const targets = records
          .filter(supportsSiwcBinding)
          .sort((a, b) => a.name.localeCompare(b.name));
        setFiles(targets);
        if (targets.length === 1) setTarget(siwcCredentialIdentity(targets[0]));
        setPhase('idle');
      })
      .catch(() => {
        if (!alive.current || request.signal.aborted) return;
        setPhase('error');
        setMessage('siwc.load_failed');
      });
    return () => {
      alive.current = false;
      request.abort();
      if (timer.current) clearTimeout(timer.current);
      startup.current?.close();
    };
  }, [requestScope]);

  const fail = (key: string) => {
    terminal.current = true;
    startup.current?.close();
    if (timer.current) clearTimeout(timer.current);
    setPhase('error');
    setMessage(key);
  };

  const verifyBinding = async () => {
    if (!selected.current || !alive.current) return;
    setPhase('verifying');
    try {
      const verified = await resolveSiwcCredential(
        requestScope,
        selected.current,
        controller.current.signal
      );
      if (!alive.current) return;
      if (verified.file.siwc_bound !== true || verified.file.use_siwc !== true)
        throw new Error('Binding not confirmed');
      setPhase('success');
      setMessage('siwc.success');
    } catch {
      if (!alive.current) return;
      setPhase('verify-error');
      setMessage('siwc.readback_failed');
    }
  };

  const poll = async (current: SiwcSession) => {
    if (!alive.current || terminal.current) return;
    if (Date.now() >= deadline.current) {
      fail('siwc.expired');
      return;
    }
    try {
      const result = await siwcApi.status(requestScope, current.state, controller.current.signal);
      if (!alive.current || terminal.current) return;
      if (result.status === 'ok') {
        terminal.current = true;
        startup.current?.complete();
        await verifyBinding();
        return;
      }
      if (result.status !== 'wait') {
        fail('siwc.failed');
        return;
      }
    } catch {
      if (!alive.current || terminal.current) return;
      setMessage('siwc.status_retry');
    }
    timer.current = setTimeout(() => void poll(current), 2000);
  };

  const start = async () => {
    if (phase !== 'idle' || startup.current) return;
    const file = files.find((item) => siwcCredentialIdentity(item) === target);
    if (!file) return;
    setPhase('starting');
    setMessage('');
    selected.current = file;
    const attempt = createSiwcStart({
      start: async () => {
        const verified = await resolveSiwcCredential(requestScope, file, controller.current.signal);
        if (!alive.current) throw new Error('Binding closed');
        return siwcApi.start(requestScope, verified.file);
      },
      cancel: (state) => siwcApi.cancel(requestScope, state),
      onResult: (result) => {
        if (!alive.current) return;
        let validUrl = false;
        try {
          validUrl = new URL(result.url).protocol === 'https:';
        } catch {
          /* Invalid server response. */
        }
        if (
          result.status !== 'ok' ||
          result.flow !== 'siwc_bind' ||
          typeof result.state !== 'string' ||
          !result.state ||
          !validUrl ||
          !Number.isFinite(result.expires_in) ||
          !(result.expires_in > 0)
        ) {
          fail('siwc.failed');
          return;
        }
        deadline.current = Date.now() + Math.min(result.expires_in, 300) * 1000;
        activeSession.current = result;
        setSession(result);
        setPhase('waiting');
        void poll(result);
      },
      onError: () => {
        if (alive.current) fail('siwc.failed');
      },
    });
    startup.current = attempt;
    await attempt.start();
  };

  const submit = async () => {
    const current = activeSession.current;
    if (!current || phase !== 'waiting' || submitting || terminal.current) return;
    if (Date.now() >= deadline.current) {
      fail('siwc.expired');
      return;
    }
    if (!isSiwcCallbackValid(callback, current.state)) {
      setMessage('siwc.invalid_callback');
      return;
    }
    setSubmitting(true);
    try {
      if (!selected.current) return;
      await resolveSiwcCredential(requestScope, selected.current, controller.current.signal);
      if (!alive.current || terminal.current) return;
      await siwcApi.callback(requestScope, callback, controller.current.signal);
      if (alive.current && !terminal.current) setMessage('siwc.submitted');
    } catch {
      if (alive.current && !terminal.current) setMessage('siwc.callback_failed');
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('siwc.title')}
      width={560}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t(phase === 'success' ? 'common.close' : 'common.cancel')}
        </Button>
      }
    >
      <div className={styles.content}>
        <p>{t('siwc.intro')}</p>
        {phase === 'loading' ? <p role="status">{t('siwc.loading')}</p> : null}
        {phase === 'idle' ? (
          <>
            <Select
              value={target}
              onChange={setTarget}
              ariaLabel={t('siwc.target')}
              options={files.map((file) => ({
                value: siwcCredentialIdentity(file),
                label: file.name,
              }))}
              placeholder={t('siwc.target')}
              fullWidth
            />
            {files.length === 0 ? <p>{t('siwc.no_targets')}</p> : null}
            <Button disabled={!target} onClick={() => void start()}>
              {t('siwc.start')}
            </Button>
          </>
        ) : null}
        {phase === 'starting' ? <p role="status">{t('siwc.starting')}</p> : null}
        {session && phase === 'waiting' ? (
          <>
            <p>{selected.current?.name}</p>
            <Input label={t('siwc.url')} value={session.url} readOnly />
            <div className={styles.actions}>
              <Button onClick={() => window.open(session.url, '_blank', 'noopener,noreferrer')}>
                {t('siwc.open')}
              </Button>
              <Button variant="secondary" onClick={() => void copyToClipboard(session.url)}>
                {t('common.copy')}
              </Button>
            </div>
            <Input
              label={t('siwc.callback')}
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
              placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…&client_id=…"
              hint={t('siwc.callback_hint')}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            <Button onClick={() => void submit()} disabled={!callback.trim()} loading={submitting}>
              {t('siwc.submit')}
            </Button>
          </>
        ) : null}
        {phase === 'verifying' ? <p role="status">{t('siwc.verifying')}</p> : null}
        {message ? <p role={phase === 'success' ? 'status' : 'alert'}>{t(message)}</p> : null}
        {phase === 'verify-error' ? (
          <Button onClick={() => void verifyBinding()}>{t('common.retry')}</Button>
        ) : null}
      </div>
    </Modal>
  );
}

export function SiwcOAuthEntry({
  requestScope,
  disabled,
}: {
  requestScope: ApiClientRequestScope;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
        {t('siwc.bind')}
      </Button>
      {open ? <SiwcBindDialog requestScope={requestScope} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
