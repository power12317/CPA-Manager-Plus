import { describe, expect, it } from 'vitest';
import { flattenCredentials, runCredentialBatch } from './credentialModel';

describe('cluster credentials', () => {
  it('keeps identically named credentials in different instances distinct', () => {
    const rows = flattenCredentials({
      total: 3,
      succeeded: 2,
      instances: [
        {
          instanceId: 'a',
          instanceName: 'A',
          data: [{ name: 'same.json', id: 'same' }],
          fetchedAtMs: 1,
        },
        {
          instanceId: 'b',
          instanceName: 'B',
          data: [{ name: 'same.json', id: 'same' }],
          fetchedAtMs: 1,
        },
        { instanceId: 'c', instanceName: 'C', data: [], error: 'offline', fetchedAtMs: 1 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('keeps batch failures scoped and serializes writes to each instance', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((instanceId) =>
      [0, 1].map((index) => ({
        key: `${instanceId}-${index}`,
        instanceId,
        instanceName: instanceId,
        file: { name: `${index}.json` },
      }))
    );
    const inFlight = new Set<string>();
    let peak = 0;
    const results = await runCredentialBatch(rows, async (row) => {
      expect(inFlight.has(row.instanceId)).toBe(false);
      inFlight.add(row.instanceId);
      peak = Math.max(peak, inFlight.size);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight.delete(row.instanceId);
      if (row.instanceId === 'b') throw new Error('offline');
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(10);
    expect(results.filter((r) => !r.ok).map((r) => r.row.instanceId)).toEqual(['b', 'b']);
    expect(results.filter((r) => r.ok)).toHaveLength(8);
  });
});
