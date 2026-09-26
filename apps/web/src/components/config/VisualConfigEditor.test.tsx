import { act, create, type ReactTestRenderer } from 'react-test-renderer';
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
      const confuse = renderer.root.findByProps({
        'aria-label': 'config_management.visual.sections.headers.identity_confuse',
      });
      const stabilize = renderer.root.findByProps({
        'aria-label': 'config_management.visual.sections.headers.stabilize_device',
      });
      expect(convergence.props.checked).toBe(true);
      expect(convergence.props.disabled).toBe(disabled);
      expect(confuse.props.checked).toBe(false);
      expect(stabilize.props.checked).toBe(false);
      if (!disabled) {
        act(() => convergence.props.onChange({ target: { checked: false } }));
        expect(onChange).toHaveBeenCalledExactlyOnceWith({ codexDeviceConvergence: false });
      }
    }
  );
});
