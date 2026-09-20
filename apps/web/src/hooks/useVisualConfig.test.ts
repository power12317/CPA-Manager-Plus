import { act, createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { useVisualConfig } from './useVisualConfig';
import { CODEX_TICKET_TIMING_FIELDS } from '@/types/visualConfig';

type UseVisualConfigResult = ReturnType<typeof useVisualConfig>;

type UseVisualConfigHarness = {
  getCurrent: () => UseVisualConfigResult;
  unmount: () => void;
};

function HookHarness({ hookRef }: { hookRef: Ref<UseVisualConfigResult> }) {
  const hook = useVisualConfig();
  useImperativeHandle(hookRef, () => hook, [hook]);
  return null;
}

const mountUseVisualConfig = (): UseVisualConfigHarness => {
  const hookRef = createRef<UseVisualConfigResult>();
  let renderer: ReactTestRenderer | null = null;

  act(() => {
    renderer = create(createElement(HookHarness, { hookRef }));
  });

  return {
    getCurrent: () => {
      if (!hookRef.current) {
        throw new Error('Failed to mount useVisualConfig test harness');
      }
      return hookRef.current;
    },
    unmount: () => {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
};

describe('useVisualConfig', () => {
  it('加载门票时间默认值时不写入配置，不改变账号目标长度', () => {
    const harness = mountUseVisualConfig();
    const yaml = 'codex:\n  turn-state-ticket:\n    enabled: false\n    target-length: 999\n';
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(yaml);
    });
    for (const { field, defaultSeconds } of CODEX_TICKET_TIMING_FIELDS) {
      expect(harness.getCurrent().visualValues[field]).toBe(String(defaultSeconds));
    }
    expect(harness.getCurrent().visualDirty).toBe(false);
    expect(harness.getCurrent().applyVisualChangesToYaml(yaml)).toBe(yaml);
    harness.unmount();
  });

  it('加载自定义时间、统一保存为数值，清空恢复默认并保留其他 YAML', () => {
    const harness = mountUseVisualConfig();
    const yaml =
      'codex:\n  turn-state-ticket:\n    ttl-seconds: 1800\n    refresh-before-seconds: 300\n    probe-interval-seconds: 9\n    attempt-timeout-seconds: 30\n    fail-closed: false\n    harvest-proxy-url: socks5://proxy.example:1080\n# 原注释\nfuture: keep\n';
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(yaml);
    });
    expect(harness.getCurrent().visualValues).toMatchObject({
      codexTicketTTLSeconds: '1800',
      codexTicketRefreshBeforeSeconds: '300',
      codexTicketProbeIntervalSeconds: '9',
      codexTicketAttemptTimeoutSeconds: '30',
    });
    act(() => {
      harness.getCurrent().setVisualValues({
        codexTicketTTLSeconds: '7200',
        codexTicketRefreshBeforeSeconds: '900',
        codexTicketProbeIntervalSeconds: '12',
        codexTicketAttemptTimeoutSeconds: '45',
      });
    });
    const saved = harness.getCurrent().applyVisualChangesToYaml(yaml);
    expect(parseYaml(saved)).toMatchObject({
      codex: {
        'turn-state-ticket': {
          'ttl-seconds': 7200,
          'refresh-before-seconds': 900,
          'probe-interval-seconds': 12,
          'attempt-timeout-seconds': 45,
          'fail-closed': false,
          'harvest-proxy-url': 'socks5://proxy.example:1080',
        },
      },
      future: 'keep',
    });
    expect(saved).toContain('# 原注释');
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(saved);
    });
    expect(harness.getCurrent().visualDirty).toBe(false);
    act(() => {
      harness.getCurrent().setVisualValues({
        codexTicketTTLSeconds: '',
        codexTicketRefreshBeforeSeconds: '',
        codexTicketProbeIntervalSeconds: '',
        codexTicketAttemptTimeoutSeconds: '',
      });
    });
    const cleared = harness.getCurrent().applyVisualChangesToYaml(saved);
    const ticket = parseYaml(cleared).codex['turn-state-ticket'];
    for (const { yamlKey } of CODEX_TICKET_TIMING_FIELDS)
      expect(ticket).not.toHaveProperty(yamlKey);
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(cleared);
    });
    for (const { field, defaultSeconds } of CODEX_TICKET_TIMING_FIELDS) {
      expect(harness.getCurrent().visualValues[field]).toBe(String(defaultSeconds));
    }
    harness.unmount();
  });

  it.each(CODEX_TICKET_TIMING_FIELDS)(
    '校验 $yamlKey、恢复原值清除脏状态且只合并已改字段',
    ({ field, yamlKey, defaultSeconds }) => {
      const harness = mountUseVisualConfig();
      const yaml = 'codex:\n  turn-state-ticket:\n    models: [gpt-6-astra]\n';
      act(() => {
        harness.getCurrent().loadVisualValuesFromYaml(yaml);
      });
      for (const invalid of ['-1', '0', '1.5', 'abc', '1e3', '9007199254740992']) {
        act(() => {
          harness.getCurrent().setVisualValues({ [field]: invalid });
        });
        expect(harness.getCurrent().visualValidationErrors[field]).toBe('positive_integer');
      }
      for (const valid of ['1', ' 42 ', '']) {
        act(() => {
          harness.getCurrent().setVisualValues({ [field]: valid });
        });
        expect(harness.getCurrent().visualValidationErrors[field]).toBeUndefined();
      }
      act(() => {
        harness.getCurrent().setVisualValues({ [field]: String(defaultSeconds) });
      });
      expect(harness.getCurrent().visualDirty).toBe(false);
      act(() => {
        harness.getCurrent().setVisualValues({ [field]: '42' });
      });
      const latest = yaml + '    enabled: true\n';
      expect(
        parseYaml(harness.getCurrent().applyVisualChangesToYaml(latest)).codex['turn-state-ticket']
      ).toEqual({ models: ['gpt-6-astra'], enabled: true, [yamlKey]: 42 });
      harness.unmount();
    }
  );

  it('后端非正数时间按默认值显示，不在未编辑时改写源码', () => {
    const harness = mountUseVisualConfig();
    const yaml =
      'codex:\n  turn-state-ticket:\n    ttl-seconds: 0\n    refresh-before-seconds: -1\n';
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(yaml);
    });
    expect(harness.getCurrent().visualValues.codexTicketTTLSeconds).toBe('3600');
    expect(harness.getCurrent().visualValues.codexTicketRefreshBeforeSeconds).toBe('600');
    expect(harness.getCurrent().applyVisualChangesToYaml(yaml)).toBe(yaml);
    harness.unmount();
  });
  it('将门票字段纳入统一草稿，只更新修改的字段并保留高级配置和源码修改', () => {
    const harness = mountUseVisualConfig();
    const yaml =
      'codex:\n  turn-state-ticket:\n    enabled: false\n    fail-closed: false\n    harvest-proxy-url: socks5://saved:secret@proxy:1080\n    ttl-seconds: 2700\n    models: [gpt-6-astra]\n# 保留注释\n';
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(yaml);
    });
    expect(harness.getCurrent().visualValues.codexTicketModels).toBe('gpt-6-astra');
    expect(harness.getCurrent().visualDirty).toBe(false);
    act(() => {
      harness
        .getCurrent()
        .setVisualValues({
          codexTicketEnabled: true,
          codexTicketFailClosed: true,
          codexTicketModels: 'gpt-6-astra,gpt-5.6-sol\ngpt-6-astra',
          proxyUrl: 'http://business:8080',
        });
    });
    expect(harness.getCurrent().visualDirty).toBe(true);
    const next = harness.getCurrent().applyVisualChangesToYaml(yaml + 'future: preserved\n');
    expect(parseYaml(next)).toMatchObject({
      codex: {
        'turn-state-ticket': {
          enabled: true,
          'fail-closed': true,
          'ttl-seconds': 2700,
          'harvest-proxy-url': 'socks5://saved:secret@proxy:1080',
          models: ['gpt-6-astra', 'gpt-5.6-sol'],
        },
      },
      future: 'preserved',
      'proxy-url': 'http://business:8080',
    });
    expect(next).toContain('# 保留注释');
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(next);
    });
    expect(harness.getCurrent().visualDirty).toBe(false);
    act(() => {
      harness.getCurrent().setVisualValues({ codexTicketHarvestProxy: '', codexTicketModels: '' });
    });
    expect(
      parseYaml(harness.getCurrent().applyVisualChangesToYaml(next)).codex['turn-state-ticket']
    ).toMatchObject({ 'harvest-proxy-url': '', models: [] });
    harness.unmount();
  });

  it('旧配置不自动写入门票默认值，恢复原值后清除脏状态', () => {
    const harness = mountUseVisualConfig();
    const yaml = 'debug: false\n';
    act(() => {
      harness.getCurrent().loadVisualValuesFromYaml(yaml);
    });
    expect(harness.getCurrent().applyVisualChangesToYaml(yaml)).toBe(yaml);
    act(() => {
      harness.getCurrent().setVisualValues({ codexTicketEnabled: true });
    });
    expect(harness.getCurrent().visualDirty).toBe(true);
    act(() => {
      harness.getCurrent().setVisualValues({ codexTicketEnabled: false });
    });
    expect(harness.getCurrent().visualDirty).toBe(false);
    harness.unmount();
  });
  it('clears the page dirty state when API keys are the only changed field', () => {
    const harness = mountUseVisualConfig();
    const initialYaml = ['proxy-url: http://proxy.local:8080', 'api-keys:', '  - old-key', ''].join(
      '\n'
    );

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(initialYaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({ apiKeysText: 'old-key\nnew-key' });
    });
    expect(harness.getCurrent().visualDirty).toBe(true);

    act(() => {
      harness.getCurrent().commitApiKeysText('old-key\nnew-key');
    });

    expect(harness.getCurrent().visualDirty).toBe(false);
    expect(harness.getCurrent().applyVisualChangesToYaml(initialYaml)).toBe(
      initialYaml
    );
    harness.unmount();
  });

  it('applies ordinary Visual changes to latest YAML without overwriting an immediate API key', () => {
    const harness = mountUseVisualConfig();
    const initialYaml = ['proxy-url: http://proxy.local:8080', 'api-keys:', '  - old-key', ''].join(
      '\n'
    );
    const latestYaml = [
      'proxy-url: http://proxy.local:8080',
      'api-keys:',
      '  - old-key',
      '  - new-key',
      '',
    ].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(initialYaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({ proxyUrl: 'http://next-proxy.local:8080' });
      harness.getCurrent().commitApiKeysText('old-key\nnew-key');
    });

    const parsed = parseYaml(
      harness.getCurrent().applyVisualChangesToYaml(latestYaml)
    ) as { ['api-keys']?: string[]; ['proxy-url']?: string };
    expect(parsed['proxy-url']).toBe('http://next-proxy.local:8080');
    expect(parsed['api-keys']).toEqual(['old-key', 'new-key']);
    expect(harness.getCurrent().visualDirty).toBe(true);
    harness.unmount();
  });

  it('commits only API keys while preserving other visual dirty fields', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['proxy-url: http://proxy.local:8080', 'api-keys:', '  - old-key', ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({
        proxyUrl: 'http://next-proxy.local:8080',
        apiKeysText: 'old-key\nnew-key',
      });
    });

    expect(harness.getCurrent().visualDirty).toBe(true);

    act(() => {
      harness.getCurrent().commitApiKeysText('old-key\nnew-key');
    });

    expect(harness.getCurrent().visualValues.apiKeysText).toBe('old-key\nnew-key');
    expect(harness.getCurrent().visualValues.proxyUrl).toBe('http://next-proxy.local:8080');
    expect(harness.getCurrent().visualDirty).toBe(true);

    act(() => {
      harness.getCurrent().setVisualValues({ proxyUrl: 'http://proxy.local:8080' });
    });

    expect(harness.getCurrent().visualDirty).toBe(false);
    harness.unmount();
  });

  it('loads CPA weighted routing aliases and writes the canonical strategy', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['routing:', '  strategy: wrr', ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
    });
    expect(harness.getCurrent().visualValues.routingStrategy).toBe('weighted-round-robin');
    harness.unmount();

    const writeHarness = mountUseVisualConfig();
    const roundRobinYaml = ['routing:', '  strategy: round-robin', ''].join('\n');

    act(() => {
      expect(writeHarness.getCurrent().loadVisualValuesFromYaml(roundRobinYaml).ok).toBe(true);
      writeHarness.getCurrent().setVisualValues({ routingStrategy: 'weighted-round-robin' });
    });

    const parsed = parseYaml(
      writeHarness.getCurrent().applyVisualChangesToYaml(roundRobinYaml)
    ) as {
      routing?: { strategy?: string };
    };
    expect(parsed.routing?.strategy).toBe('weighted-round-robin');
    writeHarness.unmount();
  });

  it('loads plugin system state from plugins.enabled', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['plugins:', '  enabled: true', ''].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });

    expect(harness.getCurrent().visualValues.pluginsEnabled).toBe(true);
    harness.unmount();
  });

  it('loads plugin directory and store sources from plugins config', () => {
    const harness = mountUseVisualConfig();
    const yaml = [
      'plugins:',
      '  enabled: true',
      '  dir: /data/cpa/plugins',
      '  store-sources:',
      '    - https://plugins.example.com/official.json',
      '    - https://plugins.example.com/private.json',
      '',
    ].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });

    expect(harness.getCurrent().visualValues.pluginsEnabled).toBe(true);
    expect(harness.getCurrent().visualValues.pluginsDir).toBe('/data/cpa/plugins');
    expect(harness.getCurrent().visualValues.pluginStoreSourcesText).toBe(
      [
        'https://plugins.example.com/official.json',
        'https://plugins.example.com/private.json',
      ].join('\n')
    );

    harness.unmount();
  });

  it('loads plugin store auth rules from plugins config', () => {
    const harness = mountUseVisualConfig();
    const yaml = [
      'plugins:',
      '  store-auth:',
      '    - match: https://api.github.com/repos/acme/private/releases/',
      '      apply-to:',
      '        - metadata',
      '        - artifact',
      '      type: github-token',
      '      token-env: GITHUB_TOKEN',
      '      allow-insecure: true',
      '',
    ].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });

    expect(harness.getCurrent().visualValues.pluginStoreAuth).toEqual([
      expect.objectContaining({
        match: 'https://api.github.com/repos/acme/private/releases/',
        applyTo: ['metadata', 'artifact'],
        type: 'github-token',
        tokenEnv: 'GITHUB_TOKEN',
        allowInsecure: true,
      }),
    ]);

    harness.unmount();
  });

  it('writes plugins.enabled when enabling plugin system from visual editor', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['host: 127.0.0.1', ''].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });

    act(() => {
      harness.getCurrent().setVisualValues({ pluginsEnabled: true });
    });

    const savedYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
    expect(savedYaml).toContain('plugins:');
    expect(savedYaml).toContain('enabled: true');

    harness.unmount();
  });

  it('loads and writes request logging through the visual config editor', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['request-log: true', 'logging-to-file: false', ''].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });
    expect(harness.getCurrent().visualValues.requestLog).toBe(true);

    act(() => {
      harness.getCurrent().setVisualValues({ requestLog: false });
    });

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as Record<
      string,
      unknown
    >;
    expect(parsed['request-log']).toBe(false);
    expect(parsed['logging-to-file']).toBe(false);

    harness.unmount();
  });

  it('writes plugin directory and store sources while preserving plugin configs', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['plugins:', '  configs:', '    demo:', '      enabled: true', ''].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });

    act(() => {
      harness.getCurrent().setVisualValues({
        pluginsDir: '/opt/cpa/plugins',
        pluginStoreSourcesText: [
          'https://plugins.example.com/official.json',
          '',
          ' https://plugins.example.com/private.json ',
        ].join('\n'),
      });
    });

    const savedYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
    const parsed = parseYaml(savedYaml) as {
      plugins?: {
        dir?: string;
        'store-sources'?: string[];
        configs?: { demo?: { enabled?: boolean } };
      };
    };

    expect(parsed.plugins?.dir).toBe('/opt/cpa/plugins');
    expect(parsed.plugins?.['store-sources']).toEqual([
      'https://plugins.example.com/official.json',
      'https://plugins.example.com/private.json',
    ]);
    expect(parsed.plugins?.configs?.demo?.enabled).toBe(true);

    harness.unmount();
  });

  it('writes plugin store auth rules only after editing the auth field', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['plugins:', '  configs:', '    demo:', '      enabled: true', ''].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });

    const unchangedYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
    expect(parseYaml(unchangedYaml) as { plugins?: { 'store-auth'?: unknown } }).toEqual(
      expect.objectContaining({
        plugins: expect.not.objectContaining({ 'store-auth': expect.anything() }),
      })
    );

    act(() => {
      harness.getCurrent().setVisualValues({
        pluginStoreAuth: [
          {
            id: 'rule-1',
            match: 'https://downloads.example.com/private/',
            applyTo: ['artifact'],
            type: 'bearer',
            tokenEnv: 'PLUGIN_TOKEN',
            usernameEnv: '',
            passwordEnv: '',
            headerName: '',
            headerValueEnv: '',
            allowInsecure: false,
          },
        ],
      });
    });

    const savedYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
    const parsed = parseYaml(savedYaml) as {
      plugins?: {
        'store-auth'?: Array<Record<string, unknown>>;
        configs?: { demo?: { enabled?: boolean } };
      };
    };

    expect(parsed.plugins?.['store-auth']).toEqual([
      {
        match: 'https://downloads.example.com/private/',
        type: 'bearer',
        'apply-to': ['artifact'],
        'token-env': 'PLUGIN_TOKEN',
      },
    ]);
    expect(parsed.plugins?.configs?.demo?.enabled).toBe(true);

    harness.unmount();
  });

  it('clears plugin directory and store sources without removing plugin configs', () => {
    const harness = mountUseVisualConfig();
    const yaml = [
      'plugins:',
      '  dir: /opt/cpa/plugins',
      '  store-sources:',
      '    - https://plugins.example.com/official.json',
      '  configs:',
      '    demo:',
      '      enabled: true',
      '',
    ].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });

    act(() => {
      harness.getCurrent().setVisualValues({
        pluginsDir: '',
        pluginStoreSourcesText: '',
      });
    });

    const savedYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
    const parsed = parseYaml(savedYaml) as {
      plugins?: {
        dir?: string;
        'store-sources'?: string[];
        configs?: { demo?: { enabled?: boolean } };
      };
    };

    expect(parsed.plugins?.dir).toBeUndefined();
    expect(parsed.plugins?.['store-sources']).toBeUndefined();
    expect(parsed.plugins?.configs?.demo?.enabled).toBe(true);

    harness.unmount();
  });

  it('clears camelCase codex identityConfuse when disabling from visual editor', () => {
    const harness = mountUseVisualConfig();
    const yaml = [
      'host: 127.0.0.1',
      'codex:',
      '  identityConfuse: true',
      '  other-setting: kept',
      '',
    ].join('\n');

    act(() => {
      const result = harness.getCurrent().loadVisualValuesFromYaml(yaml);
      expect(result.ok).toBe(true);
    });
    expect(harness.getCurrent().visualValues.codexIdentityConfuse).toBe(true);

    act(() => {
      harness.getCurrent().setVisualValues({ codexIdentityConfuse: false });
    });

    const savedYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
    expect(savedYaml).not.toContain('identityConfuse: true');
    expect(savedYaml).not.toContain('identityConfuse:');
    expect(savedYaml).toContain('identity-confuse: false');
    expect(savedYaml).toContain('other-setting: kept');

    harness.unmount();
  });

  it('round-trips disable-image-generation passthrough without rewriting it', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['disable-image-generation: passthrough', 'debug: false', ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
    });
    expect(harness.getCurrent().visualValues.disableImageGeneration).toBe('passthrough');

    act(() => {
      harness.getCurrent().setVisualValues({ debug: true });
    });
    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as Record<
      string,
      unknown
    >;
    expect(parsed['disable-image-generation']).toBe('passthrough');
    expect(parsed.debug).toBe(true);

    harness.unmount();
  });

  it('applies only dirty visual fields to the latest server YAML', () => {
    const harness = mountUseVisualConfig();
    const originalYaml = ['debug: false', 'proxy-url: http://old-proxy.example', ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(originalYaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({ proxyUrl: 'http://localhost:8080' });
    });

    const latestYaml = ['debug: true', 'proxy-url: http://old-proxy.example', ''].join('\n');
    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(latestYaml)) as Record<
      string,
      unknown
    >;

    expect(parsed).toEqual({
      debug: true,
      'proxy-url': 'http://localhost:8080',
    });
    harness.unmount();
  });

  it('uses CPA defaults for absent quota and WebSocket auth fields', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['host: 127.0.0.1', ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
    });

    expect(harness.getCurrent().visualValues.quotaSwitchProject).toBe(false);
    expect(harness.getCurrent().visualValues.quotaSwitchPreviewModel).toBe(false);
    expect(harness.getCurrent().visualValues.wsAuth).toBe(true);

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as Record<
      string,
      unknown
    >;
    expect(parsed['quota-exceeded']).toBeUndefined();
    expect(parsed['ws-auth']).toBeUndefined();

    harness.unmount();
  });

  it('writes only the quota option explicitly changed from an absent quota block', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['host: 127.0.0.1', ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({ quotaSwitchProject: true });
    });

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as {
      'quota-exceeded'?: Record<string, unknown>;
    };
    expect(parsed['quota-exceeded']).toEqual({ 'switch-project': true });

    harness.unmount();
  });

  it('writes ws-auth false when the user explicitly disables the CPA default', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['host: 127.0.0.1', ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({ wsAuth: false });
    });

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as Record<
      string,
      unknown
    >;
    expect(parsed['ws-auth']).toBe(false);

    harness.unmount();
  });

  it('rejects zero Redis usage retention because CPA normalizes it to 60', () => {
    const harness = mountUseVisualConfig();

    act(() => {
      harness.getCurrent().setVisualValues({ redisUsageQueueRetentionSeconds: '0' });
    });

    expect(
      harness.getCurrent().visualValidationErrors.redisUsageQueueRetentionSeconds
    ).toBe('retention_seconds_range');
    harness.unmount();
  });

  it('keeps an existing management key unchanged during unrelated visual edits', () => {
    const harness = mountUseVisualConfig();
    const hash = '$2a$10$01234567890123456789012345678901234567890123456789012';
    const yaml = [
      'remote-management:',
      `  secret-key: '${hash}'`,
      '  allow-remote: false',
      '',
    ].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
    });
    expect(harness.getCurrent().visualValues.rmSecretKey).toBe('');
    expect(harness.getCurrent().visualValues.rmSecretKeyAction).toBe('unchanged');
    expect(harness.getCurrent().visualValues.rmSecretKeyConfigured).toBe(true);

    act(() => {
      harness.getCurrent().setVisualValues({ rmAllowRemote: true });
    });
    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as {
      'remote-management'?: Record<string, unknown>;
    };
    expect(parsed['remote-management']?.['secret-key']).toBe(hash);
    expect(parsed['remote-management']?.['allow-remote']).toBe(true);

    harness.unmount();
  });

  it('replaces a management key without trimming its bytes', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['remote-management:', "  secret-key: '$2a$10$existing'", ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({
        rmSecretKey: '  exact key  ',
        rmSecretKeyAction: 'replace',
      });
    });

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as {
      'remote-management'?: Record<string, unknown>;
    };
    expect(parsed['remote-management']?.['secret-key']).toBe('  exact key  ');

    harness.unmount();
  });

  it('does not clear an existing management key through an empty replacement', () => {
    const harness = mountUseVisualConfig();
    const hash = '$2a$10$existing';
    const yaml = ['remote-management:', `  secret-key: '${hash}'`, ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({
        rmSecretKey: '',
        rmSecretKeyAction: 'replace',
      });
    });

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as {
      'remote-management'?: Record<string, unknown>;
    };
    expect(parsed['remote-management']?.['secret-key']).toBe(hash);

    harness.unmount();
  });

  it('explicitly clears the management key to disable the Management API', () => {
    const harness = mountUseVisualConfig();
    const yaml = ['remote-management:', "  secret-key: '$2a$10$existing'", ''].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      harness.getCurrent().setVisualValues({ rmSecretKey: '', rmSecretKeyAction: 'clear' });
    });

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as {
      'remote-management'?: Record<string, unknown>;
    };
    expect(parsed['remote-management']?.['secret-key']).toBe('');

    harness.unmount();
  });

  it('loads and saves the added CPA runtime settings', () => {
    const harness = mountUseVisualConfig();
    const yaml = [
      'pprof:',
      '  enable: true',
      '  addr: 127.0.0.1:9316',
      'save-cooldown-status: true',
      'transient-error-cooldown-seconds: -1',
      'disable-claude-cloak-mode: true',
      'gpt-image-2-base-model: gpt-5.4',
      'video-result-auth-cache-ttl: 45m',
      '',
    ].join('\n');

    act(() => {
      expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
    });
    expect(harness.getCurrent().visualValues).toEqual(
      expect.objectContaining({
        pprofEnable: true,
        pprofAddr: '127.0.0.1:9316',
        saveCooldownStatus: true,
        transientErrorCooldownSeconds: '-1',
        disableClaudeCloakMode: true,
        gptImage2BaseModel: 'gpt-5.4',
        videoResultAuthCacheTtl: '45m',
      })
    );

    act(() => {
      harness.getCurrent().setVisualValues({
        pprofEnable: false,
        pprofAddr: '127.0.0.1:8316',
        saveCooldownStatus: false,
        transientErrorCooldownSeconds: '15',
        disableClaudeCloakMode: false,
        gptImage2BaseModel: 'gpt-5.4-mini',
        videoResultAuthCacheTtl: '3h',
      });
    });

    const parsed = parseYaml(harness.getCurrent().applyVisualChangesToYaml(yaml)) as Record<
      string,
      unknown
    >;
    expect(parsed.pprof).toEqual({ enable: false, addr: '127.0.0.1:8316' });
    expect(parsed['save-cooldown-status']).toBe(false);
    expect(parsed['transient-error-cooldown-seconds']).toBe(15);
    expect(parsed['disable-claude-cloak-mode']).toBe(false);
    expect(parsed['gpt-image-2-base-model']).toBe('gpt-5.4-mini');
    expect(parsed['video-result-auth-cache-ttl']).toBe('3h');

    harness.unmount();
  });

  describe('devin sensitive words', () => {
    it('parses devin.sensitive-words with trimming, filtering empty items, and preserving order', () => {
      const harness = mountUseVisualConfig();
      const yaml = [
        'devin:',
        '  sensitive-words:',
        '    - "  forbidden-token  "',
        '    - ""',
        '    - "   "',
        '    - "system prompt leak"',
        '    - "secret-key"',
        '',
      ].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      });

      expect(harness.getCurrent().visualValues.devinSensitiveWords).toEqual([
        'forbidden-token',
        'system prompt leak',
        'secret-key',
      ]);

      // Verify non-canonical keys are ignored
      const nonCanonicalYaml = [
        'devin:',
        '  sensitiveWords:',
        '    - "bad1"',
        'devin-sensitive-words:',
        '  - "bad2"',
        '',
      ].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(nonCanonicalYaml).ok).toBe(true);
      });
      expect(harness.getCurrent().visualValues.devinSensitiveWords).toEqual([]);

      harness.unmount();
    });

    it('canonically writes devin.sensitive-words into yaml', () => {
      const harness = mountUseVisualConfig();
      const initialYaml = ['port: 8080', ''].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(initialYaml).ok).toBe(true);
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: ['word1', 'word2'],
        });
      });

      const resultYaml = harness.getCurrent().applyVisualChangesToYaml(initialYaml);
      const parsed = parseYaml(resultYaml) as Record<string, unknown>;
      expect(parsed.devin).toEqual({
        'sensitive-words': ['word1', 'word2'],
      });

      harness.unmount();
    });

    it('canonically writes devin.sensitive-words trimming items and dropping empty strings', () => {
      const harness = mountUseVisualConfig();
      const initialYaml = ['port: 8080', ''].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(initialYaml).ok).toBe(true);
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: [' API ', '', 'Claude Code'],
        });
      });

      const resultYaml = harness.getCurrent().applyVisualChangesToYaml(initialYaml);
      const parsed = parseYaml(resultYaml) as Record<string, unknown>;
      expect(parsed.devin).toEqual({
        'sensitive-words': ['API', 'Claude Code'],
      });

      harness.unmount();
    });

    it('removes the devin map completely when clearing sensitive words and no other fields exist', () => {
      const harness = mountUseVisualConfig();
      const yaml = [
        'devin:',
        '  sensitive-words:',
        '    - secret',
        'port: 8080',
        '',
      ].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: [],
        });
      });

      const resultYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
      const parsed = parseYaml(resultYaml) as Record<string, unknown>;
      expect(parsed.devin).toBeUndefined();
      expect(parsed.port).toBe(8080);

      harness.unmount();
    });

    it('preserves unknown future sibling properties under devin when editing sensitive words', () => {
      const harness = mountUseVisualConfig();
      const yaml = [
        'devin:',
        '  sensitive-words:',
        '    - old-secret',
        '  future-option: true',
        '  nested-config:',
        '    feature-flag: enabled',
        'port: 8080',
        '',
      ].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: ['new-secret'],
        });
      });

      const resultYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
      const parsed = parseYaml(resultYaml) as Record<string, unknown>;
      expect(parsed.devin).toEqual({
        'sensitive-words': ['new-secret'],
        'future-option': true,
        'nested-config': {
          'feature-flag': 'enabled',
        },
      });

      harness.unmount();
    });

    it('preserves future sibling properties when clearing devin.sensitive-words', () => {
      const harness = mountUseVisualConfig();
      const yaml = [
        'devin:',
        '  sensitive-words:',
        '    - secret',
        '  future-option: "keep-me"',
        'port: 8080',
        '',
      ].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: [],
        });
      });

      const resultYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
      const parsed = parseYaml(resultYaml) as Record<string, unknown>;
      expect(parsed.devin).toEqual({
        'future-option': 'keep-me',
      });
      expect(parsed.port).toBe(8080);

      harness.unmount();
    });

    it('does not touch or modify the devin subtree on unrelated visual edits', () => {
      const harness = mountUseVisualConfig();
      const yaml = [
        '# Custom devin comment',
        'devin:',
        '  sensitive-words:',
        '    - do-not-touch',
        '  custom-flag: 123',
        'port: 8080',
        '',
      ].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
        harness.getCurrent().setVisualValues({
          port: '9090',
        });
      });

      const resultYaml = harness.getCurrent().applyVisualChangesToYaml(yaml);
      expect(resultYaml).toContain('# Custom devin comment');
      expect(resultYaml).toContain('custom-flag: 123');
      const parsed = parseYaml(resultYaml) as Record<string, unknown>;
      expect(parsed.port).toBe(9090);
      expect(parsed.devin).toEqual({
        'sensitive-words': ['do-not-touch'],
        'custom-flag': 123,
      });

      harness.unmount();
    });

    it('tracks the dirty lifecycle accurately for devinSensitiveWords', () => {
      const harness = mountUseVisualConfig();
      const yaml = [
        'devin:',
        '  sensitive-words:',
        '    - foo',
        '    - bar',
        '',
      ].join('\n');

      act(() => {
        expect(harness.getCurrent().loadVisualValuesFromYaml(yaml).ok).toBe(true);
      });
      expect(harness.getCurrent().visualDirty).toBe(false);

      // Setting to identical values does not mark dirty
      act(() => {
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: ['foo', 'bar'],
        });
      });
      expect(harness.getCurrent().visualDirty).toBe(false);

      // Editing marks dirty
      act(() => {
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: ['foo', 'bar', 'baz'],
        });
      });
      expect(harness.getCurrent().visualDirty).toBe(true);

      // Reverting clears dirty
      act(() => {
        harness.getCurrent().setVisualValues({
          devinSensitiveWords: ['foo', 'bar'],
        });
      });
      expect(harness.getCurrent().visualDirty).toBe(false);

      harness.unmount();
    });
  });
});
