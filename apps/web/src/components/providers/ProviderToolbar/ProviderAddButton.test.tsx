import type { ComponentProps, ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAddButton } from './ProviderAddButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name: string }) => (values ? `${key}:${values.name}` : key),
  }),
}));
vi.mock('react-dom', () => ({ createPortal: (children: ReactNode) => children }));

type Props = ComponentProps<typeof ProviderAddButton>;
let renderer: ReactTestRenderer;
let props: Props;

const mount = (overrides: Partial<Props> = {}) => {
  props = {
    kind: 'all',
    disabled: false,
    onAdd: vi.fn(),
    codexSystemScopedOAuth: true,
    onAddCodexOAuth: vi.fn(),
    ...overrides,
  };
  act(() => {
    renderer = create(<ProviderAddButton {...props} />, {
      createNodeMock: () => ({
        focus: vi.fn(),
        contains: () => false,
        offsetWidth: 220,
        offsetHeight: 180,
        getBoundingClientRect: () => ({ left: 400, right: 540, top: 100, bottom: 132 }),
      }),
    });
  });
};
const open = () =>
  act(() => renderer.root.findByProps({ 'aria-haspopup': 'menu' }).props.onClick());
const menuItems = () => renderer.root.findAllByProps({ role: 'menuitem' });
const labels = () => menuItems().map((node) => node.findByType('span').children.join(''));
const clickItem = (label: string) => {
  const item = menuItems().find((node) => node.findByType('span').children.join('') === label);
  expect(item).toBeDefined();
  act(() => item!.props.onClick());
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe('provider add menus', () => {
  it.each(['all', 'codex'] as const)(
    'keeps %s platform actions hidden until the one add button opens',
    (kind) => {
      mount({ kind });
      expect(renderer.root.findAllByType('button')).toHaveLength(1);
      expect(menuItems()).toHaveLength(0);
      open();
      const expected =
        kind === 'all'
          ? [
              'ai_providers.codex_mac_option',
              'ai_providers.codex_windows_option',
              'ai_providers.codex_api_key_option',
            ]
          : [
              'auth_login.codex_macos_oauth_button',
              'auth_login.codex_windows_oauth_button',
              'ai_providers.codex_manual_config_option',
            ];
      expect(labels()).toEqual(expect.arrayContaining(expected));
      if (kind === 'codex') {
        expect(labels()).toEqual(expected);
        expect(renderer.root.findAllByProps({ role: 'separator' })).toHaveLength(1);
      }
      expect(labels()).not.toContain('Codex');
      clickItem(expected[0]);
      expect(props.onAddCodexOAuth).toHaveBeenCalledExactlyOnceWith('mac');
      expect(menuItems()).toHaveLength(0);
      open();
      clickItem(expected[1]);
      expect(props.onAddCodexOAuth).toHaveBeenLastCalledWith('windows');
      open();
      clickItem(expected[2]);
      expect(props.onAdd).toHaveBeenCalledExactlyOnceWith('codex');
      expect(props.onAddCodexOAuth).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps the legacy Codex and other providers in the all menu without system support', () => {
    mount({ codexSystemScopedOAuth: false });
    open();
    expect(labels()).toContain('Codex');
    expect(labels()).toContain('Claude');
    expect(labels()).not.toContain('ai_providers.codex_mac_option');
    clickItem('Codex');
    expect(props.onAdd).toHaveBeenCalledWith('codex');
    expect(props.onAddCodexOAuth).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude'] as const)(
    'opens the existing %s editor directly without system support',
    (kind) => {
      mount({ kind, codexSystemScopedOAuth: false });
      expect(renderer.root.findAllByProps({ 'aria-haspopup': 'menu' })).toHaveLength(0);
      act(() => renderer.root.findByType('button').props.onClick());
      expect(props.onAdd).toHaveBeenCalledWith(kind);
      expect(props.onAddCodexOAuth).not.toHaveBeenCalled();
    }
  );

  it('disables opening the menu when actions are unavailable', () => {
    mount({ disabled: true });
    expect(renderer.root.findByType('button').props.disabled).toBe(true);
    open();
    expect(menuItems()).toHaveLength(0);
    expect(props.onAddCodexOAuth).not.toHaveBeenCalled();
  });

  it('dismisses the menu on Escape and outside click', () => {
    mount({ kind: 'codex' });
    open();
    act(() =>
      renderer.root
        .findByProps({ role: 'menu' })
        .props.onKeyDown({ key: 'Escape', preventDefault: vi.fn() })
    );
    expect(menuItems()).toHaveLength(0);
    open();
    const listeners = vi.mocked(document.addEventListener).mock.calls;
    const outsideListeners = listeners.filter(([type]) => type === 'mousedown');
    const outsideClick = outsideListeners[outsideListeners.length - 1][1] as EventListener;
    act(() => outsideClick({ target: {} } as unknown as Event));
    expect(menuItems()).toHaveLength(0);
    expect(props.onAddCodexOAuth).not.toHaveBeenCalled();
  });

  it('closes an open system menu when switching to an unsupported CPA', () => {
    mount();
    open();
    expect(labels()).toContain('ai_providers.codex_mac_option');
    act(() => renderer.update(<ProviderAddButton {...props} codexSystemScopedOAuth={false} />));
    expect(menuItems()).toHaveLength(0);
    open();
    expect(labels()).toContain('Codex');
    expect(labels()).not.toContain('ai_providers.codex_mac_option');
  });
});
