import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventNotificationInstanceName } from './useEventNotificationInstanceName';

const mocks = vi.hoisted(() => ({ list: vi.fn(), client: vi.fn() }));
vi.mock('@/services/api/cluster', () => ({
  clusterApi: (...args: unknown[]) => {
    mocks.client(...args);
    return { list: mocks.list };
  },
}));

let renderer: ReactTestRenderer;
const first = 'https://manager.example/api/instances/default';
const second = 'https://manager.example/api/instances/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function Harness({ base = first, enabled = true }: { base?: string; enabled?: boolean }) {
  const name = useEventNotificationInstanceName(
    { apiBase: base, managementKey: 'test-key' },
    enabled
  );
  return <output>{name}</output>;
}
const current = () => renderer.root.findByType('output').props.children;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
});

describe('event notification instance name', () => {
  it('gets only the selected instance name and ignores an aborted prior lookup', async () => {
    let resolveOld!: (instances: Array<{ id: string; name: string }>) => void;
    mocks.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    await act(async () => {
      renderer = create(<Harness />);
    });
    const signal = mocks.list.mock.calls[0][0] as AbortSignal;
    expect(current()).toBe('');
    mocks.list.mockResolvedValueOnce([
      { id: 'default', name: 'Wrong CPA' },
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Second CPA' },
    ]);
    await act(async () => renderer.update(<Harness base={second} />));
    expect(signal.aborted).toBe(true);
    expect(current()).toBe('Second CPA');
    await act(async () => resolveOld([{ id: 'default', name: 'First CPA' }]));
    expect(current()).toBe('Second CPA');
    expect(mocks.client).toHaveBeenLastCalledWith(second, 'test-key');
  });

  it('does not use the previous name while a new lookup is pending or failed', async () => {
    mocks.list.mockResolvedValueOnce([{ id: 'default', name: 'First CPA' }]);
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(current()).toBe('First CPA');
    let rejectNext!: (error: Error) => void;
    mocks.list.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectNext = reject;
      })
    );
    await act(async () => renderer.update(<Harness base={second} />));
    expect(current()).toBe('');
    await act(async () => rejectNext(new Error('offline')));
    expect(current()).toBe('');
  });

  it.each([
    { base: first, enabled: false },
    { base: 'https://direct-cpa.example', enabled: false },
    { base: 'https://manager.example', enabled: true },
  ])('does not query instances outside a selected Manager CPA: %j', async (props) => {
    await act(async () => {
      renderer = create(<Harness {...props} />);
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(current()).toBe('');
  });
});
