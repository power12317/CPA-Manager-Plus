import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';
import { EventNotificationsSettingsCard } from './EventNotificationsSettingsCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('EventNotificationsSettingsCard', () => {
  it('uses one platform selector and treats an empty webhook as disabled configuration', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <EventNotificationsSettingsCard
          values={{ ...DEFAULT_VISUAL_VALUES, eventNotificationWebhook: '' }}
          onChange={() => {}}
        />
      );
    });

    const selector = renderer.root.findByType(Select);
    expect(renderer.root.findAllByType(ToggleSwitch)).toHaveLength(0);
    expect(selector.props.options.map((option: { value: string }) => option.value)).toEqual([
      'feishu',
      'wecom',
      'dingtalk',
    ]);
    const webhook = renderer.root
      .findAllByType(Input)
      .find((input) => input.props.label === 'event_notifications.webhook');
    expect(webhook?.props.value).toBe('');
    expect(webhook?.props.hint).toBe('event_notifications.webhook_hint');

    act(() => renderer.unmount());
  });

  it('updates the selected platform and disables the unused WeCom secret', () => {
    const onChange = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <EventNotificationsSettingsCard
          values={{ ...DEFAULT_VISUAL_VALUES, eventNotificationPlatform: 'wecom' }}
          onChange={onChange}
        />
      );
    });

    const selector = renderer.root.findByType(Select);
    act(() => selector.props.onChange('dingtalk'));
    expect(onChange).toHaveBeenCalledWith({
      eventNotificationPlatform: 'dingtalk',
      eventNotificationSecret: '',
    });
    const secret = renderer.root
      .findAllByType(Input)
      .find((input) => input.props.label === 'event_notifications.secret');
    expect(secret?.props.disabled).toBe(true);
    expect(secret?.props.hint).toBe('event_notifications.secret_not_used');

    act(() => renderer.unmount());
  });

  it('shows field validation and disables edits while configuration is saving', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <EventNotificationsSettingsCard
          values={DEFAULT_VISUAL_VALUES}
          disabled
          onChange={() => {}}
          validationErrors={{
            eventNotificationWebhook: 'event_notification_webhook_invalid',
            eventNotificationInstanceName: 'event_notification_name_required',
          }}
        />
      );
    });
    const inputs = renderer.root.findAllByType(Input);
    expect(inputs.every((input) => input.props.disabled)).toBe(true);
    expect(renderer.root.findByType(Select).props.disabled).toBe(true);
    expect(
      inputs.find((input) => input.props.label === 'event_notifications.instance_name')?.props.error
    ).toBe('config_management.visual.validation.event_notification_name_required');
    expect(
      inputs.find((input) => input.props.label === 'event_notifications.webhook')?.props.error
    ).toBe('config_management.visual.validation.event_notification_webhook_invalid');
    act(() => renderer.unmount());
  });
});
