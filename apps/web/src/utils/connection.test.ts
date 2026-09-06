import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DOCKER_CPA_BASE_URL,
  resolveDefaultCPAConnectionBase,
  detectApiBaseFromLocation,
  computeApiUrl,
} from './connection';

describe('deployment path detection', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ['/management.html', ''],
    ['/cpamc1/management.html', '/cpamc1'],
    ['/cpamc10/', '/cpamc10'],
    ['/nested/cpamp/management.html', '/nested/cpamp'],
    ['/cpamp/api/instances/default/management.html', '/cpamp/api/instances/default'],
  ])('keeps the API under %s', (pathname, prefix) => {
    vi.stubGlobal('window', {
      location: { protocol: 'https:', hostname: 'example.com', port: '', pathname },
    });
    expect(detectApiBaseFromLocation()).toBe(`https://example.com${prefix}`);
    expect(computeApiUrl(detectApiBaseFromLocation())).toBe(
      `https://example.com${prefix}/v0/management`
    );
  });
});

describe('resolveDefaultCPAConnectionBase', () => {
  it('uses the explicit environment default first', () => {
    expect(
      resolveDefaultCPAConnectionBase({
        hostedByUsageService: true,
        currentBase: 'http://panel.local:18317',
        envDefault: 'cpa.local:8317',
      })
    ).toBe('http://cpa.local:8317');
  });

  it('uses the Docker host default when the panel is hosted by Usage Service', () => {
    expect(
      resolveDefaultCPAConnectionBase({
        hostedByUsageService: true,
        currentBase: 'http://panel.local:18317',
        envDefault: '',
      })
    ).toBe(DEFAULT_DOCKER_CPA_BASE_URL);
  });

  it('keeps the current base for regular CPA-hosted panels', () => {
    expect(
      resolveDefaultCPAConnectionBase({
        hostedByUsageService: false,
        currentBase: 'http://cpa.local:8317/',
        envDefault: '',
      })
    ).toBe('http://cpa.local:8317');
  });
});
