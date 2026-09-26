import { act, type PropsWithChildren } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexOailbBorrowSettings } from './CodexOailbBorrowSettings';
import type { OailbBorrowStatus } from '@/services/api/oailbBorrow';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  credentials: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  end: vi.fn(),
  saved: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/services/api/oailbBorrow', () => ({
  oailbBorrowApi: () => ({ get: mocks.get, credentials: mocks.credentials, save: mocks.save }),
  oailbBorrowErrorCode: () => 'oailb_borrow_unavailable',
}));
vi.mock('@/services/api/cluster', () => ({ clusterApi: () => ({ list: mocks.list }) }));
vi.mock('@/components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/ui/Select', () => ({
  Select: ({
    value,
    options,
    onChange,
    disabled,
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const target = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const source = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const other = 'cccccccccccccccccccccccccccccccc';
const scope = {
  apiBase: `https://manager.example/prefix/api/instances/${target}`,
  managementKey: 'admin',
};
const props = {
  scope,
  managerMode: true,
  onOperationStart: mocks.start,
  onOperationEnd: mocks.end,
  onSaved: mocks.saved,
};
const status = (sourceInstanceId = source): OailbBorrowStatus => ({
  supported: true,
  configured: true,
  sourceInstanceId,
  sourceAuthId: 'stable-id',
  sourceAuthFile: 'codex-windows.json',
});
let renderer: ReactTestRenderer;
const button = (suffix: string) =>
  renderer.root.findAllByType('button').find((node) => node.children.join('').endsWith(suffix))!;
const options = (index: number) => {
  const select = renderer.root.findAllByType('select')[index];
  return select.findAllByType('option').map((node) => node.props.value);
};
const change = async (index: number, value: string) => {
  await act(async () => {
    renderer.root.findAllByType('select')[index].props.onChange({ target: { value } });
  });
};
const mount = async (
  override: Partial<typeof props> & { sourceDirty?: boolean; disabled?: boolean } = {}
) => {
  await act(async () => {
    renderer = create(<CodexOailbBorrowSettings {...props} {...override} />);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReset().mockResolvedValue({ supported: true, configured: false });
  mocks.credentials
    .mockReset()
    .mockResolvedValue([{ id: 'stable-id', name: 'codex-windows.json' }]);
  mocks.save.mockReset().mockResolvedValue(status());
  mocks.saved.mockReset().mockResolvedValue(true);
  mocks.start.mockReset();
  mocks.list.mockReset().mockResolvedValue([
    { id: target, name: 'Current', enabled: true, ready: true },
    { id: source, name: 'Source', enabled: true, ready: true },
    { id: other, name: 'Other', enabled: true, ready: true },
    { id: 'disabled', name: 'Disabled', enabled: false, ready: true },
  ]);
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});

describe('CodexOailbBorrowSettings', () => {
  it('defaults to no borrowing, excludes self, and submits only the selected source and stable id', async () => {
    await mount();
    expect(renderer.root.findAllByType('select')).toHaveLength(1);
    expect(options(0)).toEqual(['', source, other]);
    expect(mocks.save).not.toHaveBeenCalled();
    await change(0, source);
    expect(button('.save').props.disabled).toBe(true);
    expect(
      renderer.root
        .findAllByType('option')
        .some((option) => option.children.join('') === 'codex-windows.json')
    ).toBe(true);
    await change(1, 'stable-id');
    await act(async () => {
      button('.save').props.onClick();
    });
    expect(mocks.save).toHaveBeenCalledWith(
      { sourceInstanceId: source, sourceAuthId: 'stable-id' },
      expect.any(AbortSignal)
    );
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.saved).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('oailb_borrow.saved');
  });

  it('requires a new credential selection after changing the source and ignores late responses', async () => {
    let resolveOld!: (items: Array<{ id: string; name: string }>) => void;
    mocks.credentials
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce([{ id: 'other-stable-id', name: 'other.json' }]);
    await mount();
    await change(0, source);
    const oldSignal = mocks.credentials.mock.calls[0][1] as AbortSignal;
    await change(0, other);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      resolveOld([{ id: 'old-id', name: 'old.json' }]);
    });
    expect(options(1)).toEqual(['', 'other-stable-id']);
    expect(button('.save').props.disabled).toBe(true);
    await change(1, 'other-stable-id');
    await change(0, source);
    expect(renderer.root.findAllByType('select')[1].props.value).toBe('');
    expect(button('.save').props.disabled).toBe(true);
  });

  it('retains an unavailable saved source until the user explicitly clears it', async () => {
    mocks.get.mockResolvedValue(status('removed-source'));
    mocks.save.mockResolvedValue({ supported: true, configured: false });
    await mount();
    expect(renderer.root.findAllByType('select')[0].props.value).toBe('removed-source');
    expect(options(1)).toContain('stable-id');
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    await change(0, '');
    await act(async () => {
      button('.save').props.onClick();
    });
    expect(mocks.save).toHaveBeenCalledWith(
      { sourceInstanceId: '', sourceAuthId: '' },
      expect.any(AbortSignal)
    );
  });

  it('shows unsupported without loading the registry and can retry after a CPA upgrade', async () => {
    mocks.get.mockResolvedValueOnce({ supported: false, configured: false });
    await mount();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('select')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('oailb_borrow.unsupported');
    await act(async () => {
      button('common.refresh').props.onClick();
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('select')).toHaveLength(1);
  });

  it('makes no Manager requests in CPA Panel mode', async () => {
    await mount({ managerMode: false });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('oailb_borrow.manager_required');
  });

  it('blocks independent save while the raw YAML contains unsaved changes', async () => {
    await mount({ sourceDirty: true });
    expect(button('.save').props.disabled).toBe(true);
    await act(async () => {
      button('.save').props.onClick();
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('aborts an in-flight save on instance switch and never applies its result to the next instance', async () => {
    mocks.get.mockResolvedValueOnce(status());
    let resolveSave!: (value: OailbBorrowStatus) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        })
    );
    await mount();
    await act(async () => {
      button('.save').props.onClick();
    });
    const saveSignal = mocks.save.mock.calls[0][1] as AbortSignal;
    await act(async () => {
      renderer.update(
        <CodexOailbBorrowSettings
          {...props}
          scope={{ ...scope, apiBase: `https://manager.example/prefix/api/instances/${other}` }}
        />
      );
    });
    expect(saveSignal.aborted).toBe(true);
    await act(async () => {
      resolveSave(status());
    });
    expect(mocks.saved).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('select')[0].props.value).toBe('');
  });

  it('does not release another configuration mutation lock when acquiring it fails', async () => {
    mocks.start.mockImplementation(() => {
      throw new Error('private detail');
    });
    await mount();
    await act(async () => {
      button('.save').props.onClick();
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.end).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).not.toContain('private detail');
  });
});
