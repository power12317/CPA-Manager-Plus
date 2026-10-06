import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_TICKET_TIMING_FIELDS, DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';
import { CodexTurnStateSettingsCard } from './CodexTurnStateSettingsCard';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  auth: {
    apiBase: 'http://manager/api/instances/a',
    managementKey: 'admin',
    connectionStatus: 'connected',
  },
}));
vi.mock('@/stores', () => ({
  useAuthStore: (selector: (value: typeof mocks.auth) => unknown) => selector(mocks.auth),
}));
vi.mock('@/services/api/codexTurnState', () => ({ codexTurnStateApi: { status: mocks.status } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let view: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => view?.unmount());
  mocks.status.mockReset();
  mocks.auth.apiBase = 'http://manager/api/instances/a';
});
const mount = async (onChange = vi.fn()) => {
  await act(async () => {
    view = create(
      createElement(CodexTurnStateSettingsCard, { values: DEFAULT_VISUAL_VALUES, onChange })
    );
  });
  return onChange;
};

describe('原生门票配置草稿', () => {
  it('显示四个时间输入并将修改送到共享草稿，同时说明默认代理和账号长度', async () => {
    mocks.status.mockResolvedValue({ enabled: false });
    const onChange = await mount();
    const inputs = view!.root.findAllByType('input').filter((node) => node.props.type === 'number');
    expect(inputs).toHaveLength(4);
    CODEX_TICKET_TIMING_FIELDS.forEach(({ field, defaultSeconds }, index) => {
      expect(inputs[index].props.value).toBe(String(defaultSeconds));
      act(() => inputs[index].props.onChange({ target: { value: '42' } }));
      expect(onChange).toHaveBeenLastCalledWith({ [field]: '42' });
    });
    const text = JSON.stringify(view!.toJSON());
    expect(text).toContain('codex_turn_state.target_length_hint');
    expect(text).toContain('codex_turn_state.harvest_proxy_hint');
  });

  it('数字校验错误可见且页面忙时所有时间输入禁用', async () => {
    mocks.status.mockResolvedValue({ enabled: false });
    await act(async () => {
      view = create(
        createElement(CodexTurnStateSettingsCard, {
          values: { ...DEFAULT_VISUAL_VALUES, codexTicketTTLSeconds: '-1' },
          validationErrors: { codexTicketTTLSeconds: 'positive_integer' },
          disabled: true,
          onChange: vi.fn(),
        })
      );
    });
    const inputs = view!.root.findAllByType('input').filter((node) => node.props.type === 'number');
    expect(inputs.every((node) => node.props.disabled)).toBe(true);
    expect(inputs[0].props['aria-invalid']).toBe(true);
    expect(JSON.stringify(view!.toJSON())).toContain(
      'config_management.visual.validation.positive_integer'
    );
  });
  it('旧服务返回 404 时显示兼容提示且不暴露编辑控件', async () => {
    mocks.status.mockRejectedValue({ status: 404 });
    await mount();
    expect(JSON.stringify(view?.toJSON())).toContain('codex_turn_state.unsupported_backend');
    expect(view!.root.findAllByType('textarea')).toHaveLength(0);
  });

  it('仅修改父级草稿，不提供独立保存，能力响应不覆盖用户字段', async () => {
    mocks.status.mockResolvedValue({ enabled: true, models: ['server-model'] });
    const onChange = await mount();
    expect(view!.root.findByType('textarea').props.value).toBe(
      DEFAULT_VISUAL_VALUES.codexTicketModels
    );
    act(() =>
      view!.root.findByType('textarea').props.onChange({ target: { value: 'user-model' } })
    );
    expect(onChange).toHaveBeenCalledWith({ codexTicketModels: 'user-model' });
    expect(JSON.stringify(view!.toJSON())).not.toContain('common.save');
    expect(view!.root.findByProps({ type: 'password' }).props.autoComplete).toBe('off');
  });

  it('切换实例时禁用旧状态、丢弃晚到响应，卸载取消请求', async () => {
    let resolveA!: (value: unknown) => void;
    mocks.status.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveA = resolve;
      })
    );
    await mount();
    const signalA = mocks.status.mock.calls[0][1] as AbortSignal;
    mocks.auth.apiBase = 'http://manager/api/instances/b';
    mocks.status.mockRejectedValueOnce({ status: 404 });
    await act(async () => {
      view!.update(
        createElement(CodexTurnStateSettingsCard, {
          values: DEFAULT_VISUAL_VALUES,
          onChange: vi.fn(),
        })
      );
    });
    expect(signalA.aborted).toBe(true);
    await act(async () => {
      resolveA({ enabled: true });
    });
    expect(JSON.stringify(view!.toJSON())).toContain('codex_turn_state.unsupported_backend');
    expect(view!.root.findAllByType('textarea')).toHaveLength(0);
    const signalB = mocks.status.mock.calls[1][1] as AbortSignal;
    act(() => view!.unmount());
    expect(signalB.aborted).toBe(true);
  });
});
