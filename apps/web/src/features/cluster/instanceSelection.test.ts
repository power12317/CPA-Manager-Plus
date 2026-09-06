import { describe, expect, it } from 'vitest';
import { latestAvailableInstance } from './instanceSelection';
import type { CPAInstance } from '@/services/api/cluster';

const instance = (id: string, createdAtMs: number, enabled = true, ready = true): CPAInstance => ({
  id,
  createdAtMs,
  enabled,
  ready,
  name: id,
  baseUrl: 'http://cpa',
  managementKeyConfigured: true,
});

describe('default instance for scoped pages', () => {
  it('selects the latest added available instance regardless of list order', () => {
    const items = [instance('newest', 30), instance('default', 0), instance('older', 10)];
    expect(latestAvailableInstance(items)?.id).toBe('newest');
  });
  it('skips disabled or unavailable instances and falls back to default', () => {
    expect(
      latestAvailableInstance([
        instance('default', 0),
        instance('disabled', 30, false),
        instance('opening', 40, true, false),
      ])?.id
    ).toBe('default');
  });
  it('prefers an added instance over default for older registries without timestamps', () => {
    expect(latestAvailableInstance([instance('added', 0), instance('default', 0)])?.id).toBe(
      'added'
    );
  });
});
