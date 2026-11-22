import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SiwcCredentialToggle } from './SiwcCredentialToggle';

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/services/api/siwc', async (original) => ({
  ...(await original<object>()),
  resolveSiwcCredential: mocks.resolve,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope = { apiBase: 'https://cpa', managementKey: 'local-key' };
const file = { name: 'codex.json', type: 'codex', auth_index: '1' };
let view: ReactTestRenderer | undefined;
beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue({ scope, file: { ...file, siwc_bound: true } });
});
afterEach(() => {
  act(() => view?.unmount());
});

describe('SIWC credential switch', () => {
  it('renders one Use SIWC switch using a controlled draft value', async () => {
    const changeUse = vi.fn();
    await act(async () => {
      view = create(
        <SiwcCredentialToggle
          file={file}
          requestScope={scope}
          checked
          disabled={false}
          onChange={changeUse}
        />
      );
    });
    const switches = view!.root.findAllByType(ToggleSwitch);
    expect(switches.map((node) => node.props.ariaLabel)).toEqual(['siwc.use']);
    expect(switches[0].props.checked).toBe(true);
    act(() => switches[0].props.onChange(false));
    expect(changeUse).toHaveBeenCalledExactlyOnceWith(false);
    expect(switches[0].props.checked).toBe(true);
  });

  it('requires a binding before enabling SIWC and disables the switch during save', async () => {
    mocks.resolve.mockResolvedValue({ scope, file: { ...file, siwc_bound: false } });
    const props = {
      file,
      requestScope: scope,
      checked: false,
      disabled: false,
      onChange: vi.fn(),
    };
    await act(async () => {
      view = create(<SiwcCredentialToggle {...props} />);
    });
    expect(view!.root.findByType(ToggleSwitch).props.disabled).toBe(true);
    await act(async () => {
      view!.update(<SiwcCredentialToggle {...props} checked />);
    });
    expect(view!.root.findByType(ToggleSwitch).props.disabled).toBe(false);
    await act(async () => {
      view!.update(<SiwcCredentialToggle {...props} checked disabled />);
    });
    expect(view!.root.findAllByType(ToggleSwitch).every((node) => node.props.disabled)).toBe(true);
  });

  it('offers no switch for an unsupported or unverified credential', async () => {
    mocks.resolve.mockRejectedValue(new Error('unsupported'));
    await act(async () => {
      view = create(
        <SiwcCredentialToggle
          file={file}
          requestScope={scope}
          checked={false}
          disabled={false}
          onChange={vi.fn()}
        />
      );
    });
    expect(view!.root.findAllByType(ToggleSwitch)).toHaveLength(0);
  });
});
