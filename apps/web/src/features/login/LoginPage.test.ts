import { describe, expect, it } from 'vitest';
import { resolveLoginProbeFailureMode, resolveUsageServiceLoginMode } from './loginMode';

describe('resolveLoginProbeFailureMode', () => {
  it('never carries Manager mode from a different site or reverse-proxy prefix', () => {
    expect(
      resolveLoginProbeFailureMode(new Error('timeout'), 'https://host/cpa', {
        sessionMode: 'manager_embedded',
        apiBase: 'https://host/manager',
      })
    ).toBe('external_panel');
  });

  it('recognizes a missing Manager endpoint even when old state incorrectly says Manager', () => {
    expect(
      resolveLoginProbeFailureMode({ status: 404 }, 'https://host/cpa', {
        sessionMode: 'manager_embedded',
        apiBase: 'https://host/cpa',
      })
    ).toBe('external_panel');
  });
});

describe('resolveUsageServiceLoginMode', () => {
  it('keeps CPA-hosted panels on the regular login flow', () => {
    expect(resolveUsageServiceLoginMode(undefined)).toEqual({
      hostedByUsageService: false,
      usageServiceNeedsSetup: false,
    });
    expect(resolveUsageServiceLoginMode({ service: 'cli-proxy-api' })).toEqual({
      hostedByUsageService: false,
      usageServiceNeedsSetup: false,
    });
  });

  it('uses setup only for unconfigured Usage Service hosted panels', () => {
    expect(
      resolveUsageServiceLoginMode({ service: 'cpa-manager-plus', configured: false })
    ).toEqual({
      hostedByUsageService: true,
      usageServiceNeedsSetup: true,
    });
  });

  it('uses regular login for configured Usage Service hosted panels', () => {
    expect(resolveUsageServiceLoginMode({ service: 'cpa-manager-plus', configured: true })).toEqual(
      {
        hostedByUsageService: true,
        usageServiceNeedsSetup: false,
      }
    );
  });

  it('still recognizes legacy service ids (cpa-manager) as Usage Service', () => {
    expect(resolveUsageServiceLoginMode({ service: 'cpa-manager', configured: true })).toEqual({
      hostedByUsageService: true,
      usageServiceNeedsSetup: false,
    });
  });
});
