import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import {
  INSTANCES_CHANGED_EVENT,
  type CPAInstance,
  type InstanceInput,
} from '@/services/api/cluster';
import { useClusterClient, useClusterData } from './useClusterData';
import { navigateInstance } from './navigation';
import styles from './cluster.module.scss';

const empty: InstanceInput = { name: '', baseUrl: '', managementKey: '', enabled: true };

export function Instances() {
  const { t } = useTranslation();
  const api = useClusterClient();
  const { data, loading, error, reload } = useClusterData(api.list);
  const [editing, setEditing] = useState<string | null>(null);
  const [input, setInput] = useState<InstanceInput>(empty);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSetting, setBatchSetting] = useState('request-retry');
  const [batchValue, setBatchValue] = useState('3');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResults, setBatchResults] = useState<Record<string, 'success' | 'failed'>>({});
  const visibleData = useMemo(() => data ?? [], [data]);
  const enabledItems = useMemo(() => visibleData.filter((item) => item.enabled), [visibleData]);
  const selectedItems = useMemo(
    () => visibleData.filter((item) => selected.has(item.id)),
    [visibleData, selected]
  );
  const edit = (item?: CPAInstance) => {
    setEditing(item?.id || '');
    setInput(
      item
        ? { name: item.name, baseUrl: item.baseUrl, managementKey: '', enabled: item.enabled }
        : empty
    );
    setSaveError(false);
  };
  const runBatch = async () => {
    if (selectedItems.length === 0) return;
    setBatchBusy(true);
    setBatchResults({});
    let value: unknown = batchValue;
    if (batchSetting === 'request-retry') value = Number(batchValue);
    if (batchSetting === 'request-log' || batchSetting === 'logging-to-file' || batchSetting === 'ws-auth') {
      value = batchValue === 'true';
    }
    await Promise.all(
      selectedItems.map(async (item) => {
        try {
          await api.updateSetting(item.id, batchSetting, value);
          setBatchResults((current) => ({ ...current, [item.id]: 'success' }));
        } catch {
          setBatchResults((current) => ({ ...current, [item.id]: 'failed' }));
        }
      })
    );
    setBatchBusy(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(false);
    try {
      await api.save(input, editing || undefined);
      window.dispatchEvent(new Event(INSTANCES_CHANGED_EVENT));
      setInput(empty);
      setEditing(null);
      reload();
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (item: CPAInstance) => {
    if (!window.confirm(t('cluster.deleteConfirm', { name: item.name }))) return;
    try {
      await api.remove(item.id);
      setSelected((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      window.dispatchEvent(new Event(INSTANCES_CHANGED_EVENT));
      reload();
    } catch {
      setSaveError(true);
    }
  };
  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Button variant="secondary" onClick={reload} loading={loading}>
          {t('cluster.refresh')}
        </Button>
        <Button onClick={() => edit()}>{t('cluster.add')}</Button>
        <Button
          variant="secondary"
          disabled={selectedItems.length === 0}
          onClick={() => setBatchOpen(true)}
        >
          {t('cluster.batchSettings')}{selectedItems.length ? ` (${selectedItems.length})` : ''}
        </Button>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {t('cluster.loadError')}
        </p>
      )}
      {editing !== null && (
        <Card title={t(editing ? 'cluster.edit' : 'cluster.add')}>
          <form className={styles.form} onSubmit={submit}>
            <label>
              {t('cluster.name')}
              <input
                required
                maxLength={100}
                value={input.name}
                onChange={(e) => setInput({ ...input, name: e.target.value })}
              />
            </label>
            <label>
              {t('cluster.address')}
              <input
                required
                type="url"
                placeholder="http://cpa-01:8317"
                value={input.baseUrl}
                onChange={(e) => setInput({ ...input, baseUrl: e.target.value })}
              />
            </label>
            <label>
              {t('cluster.key')}
              <input
                type="password"
                autoComplete="new-password"
                required={!editing}
                value={input.managementKey}
                onChange={(e) => setInput({ ...input, managementKey: e.target.value })}
              />
            </label>
            <small>{t('cluster.keyHelp')}</small>
            <label>
              <span>
                <input
                  type="checkbox"
                  checked={input.enabled}
                  onChange={(e) => setInput({ ...input, enabled: e.target.checked })}
                />{' '}
                {t('cluster.enabled')}
              </span>
            </label>
            {saveError && (
              <p role="alert" className={styles.error}>
                {t('cluster.saveError')}
              </p>
            )}
            <div className={styles.actions}>
              <Button type="submit" loading={saving}>
                {t('cluster.testSave')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setEditing(null);
                  setInput(empty);
                }}
              >
                {t('cluster.cancel')}
              </Button>
            </div>
          </form>
        </Card>
      )}
      {batchOpen && (
        <Modal open={batchOpen} title={t('cluster.batchSettings')} onClose={() => !batchBusy && setBatchOpen(false)} closeDisabled={batchBusy}>
          <div className={styles.form}>
            <p>{t('cluster.batchHelp', { count: selectedItems.length })}</p>
            <label>
              {t('cluster.setting')}
              <select value={batchSetting} onChange={(event) => setBatchSetting(event.target.value)}>
                <option value="request-retry">{t('cluster.requestRetry')}</option>
                <option value="routing/strategy">{t('cluster.routingStrategy')}</option>
                <option value="proxy-url">{t('cluster.proxyUrl')}</option>
                <option value="request-log">{t('cluster.requestLog')}</option>
                <option value="logging-to-file">{t('cluster.loggingToFile')}</option>
                <option value="ws-auth">{t('cluster.wsAuth')}</option>
              </select>
            </label>
            <label>
              {t('cluster.value')}
              {batchSetting === 'routing/strategy' ? (
                <select value={batchValue} onChange={(event) => setBatchValue(event.target.value)}>
                  <option value="round-robin">round-robin</option>
                  <option value="fill-first">fill-first</option>
                  <option value="weighted-round-robin">weighted-round-robin</option>
                </select>
              ) : batchSetting === 'request-log' || batchSetting === 'logging-to-file' || batchSetting === 'ws-auth' ? (
                <select value={batchValue} onChange={(event) => setBatchValue(event.target.value)}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input value={batchValue} onChange={(event) => setBatchValue(event.target.value)} inputMode="numeric" />
              )}
            </label>
            <div className={styles.actions}>
              <Button loading={batchBusy} onClick={runBatch}>{t('cluster.applyBatch')}</Button>
              <Button type="button" variant="secondary" disabled={batchBusy} onClick={() => setBatchOpen(false)}>{t('cluster.cancel')}</Button>
            </div>
            {selectedItems.map((item) => (
              <small key={item.id}>
                {item.name}: {batchResults[item.id] === 'success' ? t('cluster.success') : batchResults[item.id] === 'failed' ? t('cluster.failed') : t('cluster.pending')}
              </small>
            ))}
          </div>
        </Modal>
      )}
      <div className={styles.tableWrap}>
        {visibleData.length === 0 ? (
          <Card>
            <p>{t('cluster.emptyInstances')}</p>
            <Button onClick={() => edit()}>{t('cluster.add')}</Button>
          </Card>
        ) : <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label={t('cluster.selectAll')}
                  checked={enabledItems.length > 0 && enabledItems.every((item) => selected.has(item.id))}
                  onChange={(event) => setSelected(event.target.checked ? new Set(enabledItems.map((item) => item.id)) : new Set())}
                />
              </th>
              <th>{t('cluster.name')}</th>
              <th>{t('cluster.address')}</th>
              <th>{t('cluster.status')}</th>
              <th>{t('cluster.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleData.map((item) => (
              <tr key={item.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    disabled={!item.enabled}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                  />
                </td>
                <td>{item.name}</td>
                <td>{item.baseUrl}</td>
                <td>
                  {t(
                    !item.ready
                      ? 'cluster.unavailable'
                      : item.online
                        ? 'cluster.online'
                      : item.enabled
                        ? 'cluster.enabled'
                        : 'cluster.disabled'
                  )}
                </td>
                <td>
                  <div className={styles.actions}>
                    <Button
                      size="sm"
                      disabled={!item.ready || !item.enabled}
                      onClick={() => navigateInstance(item.id, '/dashboard')}
                    >
                      {t('cluster.open')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!item.ready || !item.enabled}
                      onClick={() => navigateInstance(item.id, '/config')}
                    >
                      {t('cluster.configure')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => edit(item)}>
                      {t('cluster.edit')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void remove(item)}>
                      {t('cluster.delete')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>}
      </div>
      <p>{t('cluster.networkHelp')}</p>
    </div>
  );
}
