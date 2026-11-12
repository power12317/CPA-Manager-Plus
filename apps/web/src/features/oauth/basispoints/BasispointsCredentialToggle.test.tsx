import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { BasispointsCredentialToggle } from './BasispointsCredentialToggle';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), bindingStatus: vi.fn() }));
vi.mock('@/services/api/basispoints', async (original) => ({
  ...(await original<object>()),
  resolveBasispointsCredential: mocks.resolve,
  basispointsApi: { bindingStatus: mocks.bindingStatus },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = { apiBase: 'https://cpa', managementKey: 'key' };
const file = { name: 'codex.json', type: 'codex', auth_index: '1' };
let view: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ scope, file });
  mocks.bindingStatus.mockResolvedValue({ bound: true, status: 'valid', bind_supported: true });
});
afterEach(() => act(() => view?.unmount()));
describe('Basispoints credential draft switch', () => {
  it('changes only the controlled draft, independent of SIWC, until the existing Save action', async () => {
    const onChange = vi.fn();
    await act(async () => {
      view = create(
        <BasispointsCredentialToggle
          file={file}
          requestScope={scope}
          checked={false}
          disabled={false}
          onChange={onChange}
        />
      );
    });
    const toggle = view!.root.findByType(ToggleSwitch);
    expect(toggle.props.disabled).toBe(false);
    act(() => toggle.props.onChange(true));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle.props.checked).toBe(false);
  });
  it.each([false, true])(
    'disables unsupported CPAs without fabricating persisted false (saved=%s)',
    async (checked) => {
      mocks.resolve.mockRejectedValue(new Error('unsupported'));
      await act(async () => {
        view = create(
          <BasispointsCredentialToggle
            file={file}
            requestScope={scope}
            checked={checked}
            disabled={false}
            onChange={vi.fn()}
          />
        );
      });
      expect(view!.root.findByType(ToggleSwitch).props).toMatchObject({ disabled: true, checked });
    }
  );
  it('allows disabling an invalid saved binding while preventing enabling it', async () => {
    mocks.bindingStatus.mockResolvedValue({ bound: true, status: 'invalid', bind_supported: true });
    const props = { file, requestScope: scope, disabled: false, onChange: vi.fn() };
    await act(async () => {
      view = create(<BasispointsCredentialToggle {...props} checked={false} />);
    });
    expect(view!.root.findByType(ToggleSwitch).props.disabled).toBe(true);
    await act(async () => {
      view!.update(<BasispointsCredentialToggle {...props} checked />);
    });
    expect(view!.root.findByType(ToggleSwitch).props.disabled).toBe(false);
  });
});
