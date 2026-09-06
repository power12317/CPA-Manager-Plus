import type { AuthFileItem } from '@/types/authFile';
import type { ClusterAggregate } from '@/services/api/cluster';
import type { AuthFileStatusTarget } from '@/services/api/authFiles';

export interface ClusterCredential {
  key: string;
  instanceId: string;
  instanceName: string;
  file: AuthFileItem;
}

export function flattenCredentials(
  data: ClusterAggregate<AuthFileItem[]> | null
): ClusterCredential[] {
  return (data?.instances || []).flatMap((result) =>
    result.error
      ? []
      : (result.data || []).map((file) => ({
          key: JSON.stringify([result.instanceId, file.id || file.name, file.authIndex ?? '']),
          instanceId: result.instanceId,
          instanceName: result.instanceName,
          file,
        }))
  );
}

export function credentialTarget(file: AuthFileItem): AuthFileStatusTarget {
  return {
    name: file.name,
    runtimeId: file.id,
    authIndex: file.authIndex,
    provider: String(file.provider || file.type || ''),
    accountId: typeof file.account_id === 'string' ? file.account_id : undefined,
  };
}

// Serial within each instance, bounded across instances. Every outcome stays
// attached to its source row; a failure never rolls back unrelated instances.
export async function runCredentialBatch(
  rows: ClusterCredential[],
  action: (row: ClusterCredential) => Promise<unknown>
): Promise<{ row: ClusterCredential; ok: boolean }[]> {
  const groups = new Map<string, ClusterCredential[]>();
  for (const row of rows) groups.set(row.instanceId, [...(groups.get(row.instanceId) || []), row]);
  const pending = [...groups.values()];
  const results: { row: ClusterCredential; ok: boolean }[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      let group: ClusterCredential[] | undefined;
      while ((group = pending.shift())) {
        for (const row of group) {
          try {
            await action(row);
            results.push({ row, ok: true });
          } catch {
            results.push({ row, ok: false });
          }
        }
      }
    })
  );
  return results;
}
