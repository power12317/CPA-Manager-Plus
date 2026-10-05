import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisualConfigEditor } from './VisualConfigEditor';
import { DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/components/common/PageTransitionLayer', () => ({ usePageTransitionLayer: () => null }));

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
});

describe('Codex fast mode setting', () => {
  it('places the mode toggle immediately beside Basispoints in the same network settings grid', () => {
    act(() => {
      renderer = create(
        <VisualConfigEditor
          values={DEFAULT_VISUAL_VALUES}
          codexPrismCapabilities={{ supported: true, enabled: false }}
          onChange={() => {}}
          onPersistApiKeyMutation={async () => []}
          onRefreshApiKeys={async () => []}
          onApiKeyOperationStart={() => {}}
          onApiKeyOperationEnd={() => {}}
          codexModeSettings={<span data-codex-mode>Inline mode control</span>}
        />
      );
    });
    const modeToggle = renderer.root.findByProps({ 'data-codex-mode': true });
    const grid = modeToggle.parent!;
    const previousSetting = grid.children[
      grid.children.indexOf(modeToggle) - 1
    ] as ReactTestInstance;
    expect(
      previousSetting.findByProps({
        title: 'config_management.visual.sections.network.codex_basispoints',
      })
    ).toBeDefined();
    const headers = renderer.root.findByProps({
      title: 'config_management.visual.sections.headers.codex_title',
    });
    expect(headers.findAllByProps({ 'data-codex-mode': true })).toHaveLength(0);
    for (const nav of renderer.root.findAllByType('nav')) {
      expect(nav.findAllByProps({ 'data-codex-mode': true })).toHaveLength(0);
      expect(nav.findAllByProps({ href: '/codex-runtime' })).toHaveLength(0);
    }
    expect(
      grid.findByProps({
        'aria-label': 'config_management.visual.sections.network.codex_prism',
      })
    ).toBeDefined();
  });

  it('hides Prism settings when the CPA capability is missing or unsupported', () => {
    act(() => {
      renderer = create(
        <VisualConfigEditor
          values={DEFAULT_VISUAL_VALUES}
          codexPrismCapabilities={{ supported: false }}
          onChange={() => {}}
          onPersistApiKeyMutation={async () => []}
          onRefreshApiKeys={async () => []}
          onApiKeyOperationStart={() => {}}
          onApiKeyOperationEnd={() => {}}
        />
      );
    });
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'config_management.visual.sections.network.codex_prism',
      })
    ).toHaveLength(0);
  });

  it.each([false, true])('binds the Prism draft switch (disabled=%s)', (disabled) => {
    const onChange = vi.fn();
    act(() => {
      renderer = create(
        <VisualConfigEditor
          values={DEFAULT_VISUAL_VALUES}
          codexPrismCapabilities={{ supported: true, enabled: false }}
          disabled={disabled}
          onChange={onChange}
          onPersistApiKeyMutation={async () => []}
          onRefreshApiKeys={async () => []}
          onApiKeyOperationStart={() => {}}
          onApiKeyOperationEnd={() => {}}
        />
      );
    });
    const prism = renderer.root.findByProps({
      'aria-label': 'config_management.visual.sections.network.codex_prism',
    });
    expect(prism.props.checked).toBe(false);
    expect(prism.props.disabled).toBe(disabled);
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === 'input' &&
          String(node.props['aria-label'] ?? '').startsWith(
            'config_management.visual.sections.network.codex_prism'
          )
      )
    ).toHaveLength(1);
    if (!disabled) {
      act(() => prism.props.onChange({ target: { checked: true } }));
      expect(onChange).toHaveBeenLastCalledWith({ codexPrismEnabled: true });
    }
  });

  it.each([false, true])('binds the four modes (disabled=%s)', (disabled) => {
    const onChange = vi.fn();
    act(() => {
      renderer = create(
        <VisualConfigEditor
          values={DEFAULT_VISUAL_VALUES}
          disabled={disabled}
          onChange={onChange}
          onPersistApiKeyMutation={async () => []}
          onRefreshApiKeys={async () => []}
          onApiKeyOperationStart={() => {}}
          onApiKeyOperationEnd={() => {}}
        />
      );
    });
    const select = renderer.root.findByProps({
      ariaLabel: 'config_management.visual.sections.headers.codex_fast_mode',
    });
    expect(select.props.value).toBe('auto');
    expect(select.props.options.map((option: { value: string }) => option.value)).toEqual([
      'auto',
      'default',
      'fast',
      'ultrafast',
    ]);
    expect(select.props.disabled).toBe(disabled);
    if (!disabled) {
      for (const mode of ['auto', 'default', 'fast', 'ultrafast']) {
        act(() => select.props.onChange(mode));
        expect(onChange).toHaveBeenLastCalledWith({ codexFastMode: mode });
      }
    }
  });
});

describe('Codex device convergence setting', () => {
  it.each([false, true])(
    'binds an independent default-enabled switch (disabled=%s)',
    (disabled) => {
      const onChange = vi.fn();
      act(() => {
        renderer = create(
          <VisualConfigEditor
            values={DEFAULT_VISUAL_VALUES}
            disabled={disabled}
            onChange={onChange}
            onPersistApiKeyMutation={async () => []}
            onRefreshApiKeys={async () => []}
            onApiKeyOperationStart={() => {}}
            onApiKeyOperationEnd={() => {}}
          />
        );
      });
      const convergence = renderer.root.findByProps({
        'aria-label': 'config_management.visual.sections.headers.device_convergence',
      });
      const confuse = renderer.root.findAllByProps({
        'aria-label': 'config_management.visual.sections.headers.identity_confuse',
      });
      const stabilize = renderer.root.findByProps({
        'aria-label': 'config_management.visual.sections.headers.stabilize_device',
      });
      expect(convergence.props.checked).toBe(true);
      expect(convergence.props.disabled).toBe(disabled);
      expect(confuse).toHaveLength(0);
      expect(stabilize.props.checked).toBe(false);
      if (!disabled) {
        act(() => convergence.props.onChange({ target: { checked: false } }));
        expect(onChange).toHaveBeenCalledExactlyOnceWith({ codexDeviceConvergence: false });
      }
    }
  );
});
