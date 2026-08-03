import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => undefined },
  useTranslation: () => ({
    // 用 key 原样返回，方便断言 onSelect 时用哪个 key 组装了 name/prompt
    t: (key: string) => key,
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
  }),
}));

import {
  AUTOMATION_TEMPLATES,
  AutomationTemplatePicker,
} from '../AutomationTemplates';

describe('AUTOMATION_TEMPLATES', () => {
  it('包含 6–8 个模板且 id / i18n key 唯一', () => {
    expect(AUTOMATION_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(AUTOMATION_TEMPLATES.length).toBeLessThanOrEqual(8);

    const ids = AUTOMATION_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.nameKey).toMatch(/^todo:automation\.templates\./);
      expect(template.descriptionKey).toMatch(/^todo:automation\.templates\./);
      expect(template.promptKey).toMatch(/^todo:automation\.templates\./);
      expect(template.icon).toBeTruthy();
    }
  });

  it('每个模板的 schedule 按 kind 具备完整字段', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      const schedule = template.draft.schedule;
      expect(schedule, `template ${template.id} 缺少 schedule`).toBeDefined();
      if (!schedule) continue;

      expect(['daily', 'weekly', 'weekdays', 'monthly', 'interval', 'once']).toContain(schedule.kind);

      if (schedule.kind === 'interval') {
        expect(schedule.intervalMinutes).toBeTypeOf('number');
        expect(schedule.intervalMinutes).toBeGreaterThanOrEqual(5);
        expect(schedule.intervalMinutes).toBeLessThanOrEqual(1440);
      } else {
        expect(schedule.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      }

      if (schedule.kind === 'weekly') {
        expect(schedule.weekday).toBeTypeOf('number');
        expect(schedule.weekday).toBeGreaterThanOrEqual(0);
        expect(schedule.weekday).toBeLessThanOrEqual(6);
      }
      if (schedule.kind === 'monthly') {
        expect(schedule.dayOfMonth).toBeTypeOf('number');
        expect(schedule.dayOfMonth).toBeGreaterThanOrEqual(1);
        expect(schedule.dayOfMonth).toBeLessThanOrEqual(31);
      }
      if (schedule.kind === 'once') {
        // once 模板 date 留空，由用户在创建面板选择
        expect(schedule.date).toBeUndefined();
      }
    }
  });

  it('draft 的 actionType 合法且 agent_turn 模板带 sessionMode', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(['notify', 'agent_turn']).toContain(template.draft.actionType);
      if (template.draft.actionType === 'agent_turn') {
        expect(['isolated', 'named']).toContain(template.draft.sessionMode);
      }
      // prompt 留空由 picker 在 onSelect 时用 t(promptKey) 填入
      expect(template.draft.prompt).toBeUndefined();
      expect(template.draft.name).toBeUndefined();
    }
  });
});

describe('AutomationTemplatePicker', () => {
  it('渲染全部模板按钮并在点击时回调组装好的 draft', () => {
    const onSelect = vi.fn();
    render(<AutomationTemplatePicker onSelect={onSelect} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(AUTOMATION_TEMPLATES.length);

    const first = AUTOMATION_TEMPLATES[0];
    fireEvent.click(screen.getByText(first.nameKey).closest('button')!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      ...first.draft,
      name: first.nameKey,
      prompt: first.promptKey,
    });
  });

  it('disabled 时按钮禁用且不触发回调', () => {
    const onSelect = vi.fn();
    render(<AutomationTemplatePicker onSelect={onSelect} disabled />);

    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      expect(button).toBeDisabled();
    }
    fireEvent.click(buttons[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
