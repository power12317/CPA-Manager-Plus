import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  INSTANCES_CHANGED_EVENT,
  type CPAInstance,
  type InstanceInput,
} from '@/services/api/cluster';
import { useClusterClient, useClusterData } from './useClusterData';
import { navigateInstance } from './navigation';
import styles from './cluster.module.scss';

const empty: InstanceInput = { name: '', baseUrl: '', managementKey: '', enabled: true };

export function Instances({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const api = useClusterClient();
  const { data, loading, error, reload } = useClusterData(api.list);
  const [editing, setEditing] = useState<string | null>(null);
  const [input, setInput] = useState<InstanceInput>(empty);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const edit = (item?: CPAInstance) => {
    setEditing(item?.id || '');
    setInput(
      item
        ? { name: item.name, baseUrl: item.baseUrl, managementKey: '', enabled: item.enabled }
        : empty
    );
    setSaveError(false);
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
  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        {embedded ? <h2>{t('cluster.manage')}</h2> : <h1>{t('cluster.manage')}</h1>}
        <Button variant="secondary" onClick={reload} loading={loading}>
          {t('cluster.refresh')}
        </Button>
        <Button onClick={() => edit()}>{t('cluster.add')}</Button>
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
                  disabled={editing === 'default'}
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
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('cluster.name')}</th>
              <th>{t('cluster.address')}</th>
              <th>{t('cluster.status')}</th>
              <th>{t('cluster.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.baseUrl}</td>
                <td>
                  {t(
                    !item.ready
                      ? 'cluster.unavailable'
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
                    <Button size="sm" variant="secondary" onClick={() => edit(item)}>
                      {t('cluster.edit')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>{t('cluster.networkHelp')}</p>
    </div>
  );
}
