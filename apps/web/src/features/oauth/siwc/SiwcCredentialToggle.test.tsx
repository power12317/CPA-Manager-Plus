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

describe('SIWC credential switches', () => {
  it('renders the client permission beside Use SIWC using controlled draft values', async () => {
    const changeUse = vi.fn();
    const changeClient = vi.fn();
    await act(async () => {
      view = create(
        <SiwcCredentialToggle
          file={file}
          requestScope={scope}
          checked
          allowCodexClientSiwc={false}
          disabled={false}
          onChange={changeUse}
          onAllowCodexClientSiwcChange={changeClient}
        />
      );
    });
    const switches = view!.root.findAllByType(ToggleSwitch);
    expect(switches.map((node) => node.props.ariaLabel)).toEqual([
      'siwc.use',
      'siwc.allow_codex_client',
    ]);
    expect(switches.map((node) => node.props.checked)).toEqual([true, false]);
    act(() => switches[1].props.onChange(true));
    expect(changeClient).toHaveBeenCalledExactlyOnceWith(true);
    expect(changeUse).not.toHaveBeenCalled();
    expect(switches[1].props.checked).toBe(false);
  });

  it('keeps the client preference editable while SIWC is off and disables both during save', async () => {
    mocks.resolve.mockResolvedValue({ scope, file: { ...file, siwc_bound: false } });
    const props = {
      file,
      requestScope: scope,
      checked: false,
      allowCodexClientSiwc: true,
      disabled: false,
      onChange: vi.fn(),
      onAllowCodexClientSiwcChange: vi.fn(),
    };
    await act(async () => {
      view = create(<SiwcCredentialToggle {...props} />);
    });
    expect(view!.root.findAllByType(ToggleSwitch).map((node) => node.props.disabled)).toEqual([
      true,
      false,
    ]);
    await act(async () => {
      view!.update(<SiwcCredentialToggle {...props} disabled />);
    });
    expect(view!.root.findAllByType(ToggleSwitch).every((node) => node.props.disabled)).toBe(true);
  });

  it('offers neither switch for an unsupported or unverified credential', async () => {
    mocks.resolve.mockRejectedValue(new Error('unsupported'));
    await act(async () => {
      view = create(
        <SiwcCredentialToggle
          file={file}
          requestScope={scope}
          checked={false}
          allowCodexClientSiwc
          disabled={false}
          onChange={vi.fn()}
          onAllowCodexClientSiwcChange={vi.fn()}
        />
      );
    });
    expect(view!.root.findAllByType(ToggleSwitch)).toHaveLength(0);
  });
});
