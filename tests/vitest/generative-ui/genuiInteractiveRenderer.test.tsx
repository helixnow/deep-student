/**
 * WP-E：choice / form 交互块 + InteractionSubmitBar + 渲染器交互模式
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { setGenerativeActivationCheckForTests } from '@/features/generative-ui/components/InteractionSubmitBar';
import type {
  GenerativeUIInteractionBinding,
  GenerativeUISubmitOutcome,
} from '@/features/generative-ui/interaction/types';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '@/features/generative-ui/types';

function binding(overrides: Partial<GenerativeUIInteractionBinding> = {}): GenerativeUIInteractionBinding {
  return {
    state: 'pending',
    canSubmit: true,
    onSubmit: vi.fn(async (): Promise<GenerativeUISubmitOutcome> => 'accepted'),
    onSkip: vi.fn(async () => {}),
    ...overrides,
  };
}

const singleChoice: GenerativeUIIntent = {
  version: '1.1',
  blocks: [
    {
      type: 'choice',
      id: 'q1',
      props: {
        question: '2+2=?',
        options: [
          { id: 'a', label: '3' },
          { id: 'b', label: '4' },
        ],
      },
    },
  ],
};

function submitButton() {
  return screen.getByRole('button', { name: /interaction\.submit/ });
}

beforeEach(() => {
  setGenerativeActivationCheckForTests(() => true);
  // jsdom 无 rAF 时 focusFirstInvalid 静默
});
afterEach(() => {
  setGenerativeActivationCheckForTests(null);
});

describe('ChoiceBlock', () => {
  it('single: last pick wins and submits { selected: [id] } with summary', async () => {
    const b = binding();
    render(<GenerativeUIRenderer intent={singleChoice} interaction={b} showChrome={false} />);
    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[0]!);
    fireEvent.click(radios[1]!);
    expect(radios[1]).toBeChecked();
    expect(radios[0]).not.toBeChecked();
    fireEvent.click(submitButton());
    await waitFor(() => expect(b.onSubmit).toHaveBeenCalledTimes(1));
    const payload = (b.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.data).toEqual({ q1: { selected: ['b'] } });
    expect(payload.summary).toContain('2+2=?');
    expect(payload.summary).toContain('4');
  });

  it('required single without selection marks the block invalid and does not submit', async () => {
    const b = binding();
    const { container } = render(<GenerativeUIRenderer intent={singleChoice} interaction={b} showChrome={false} />);
    fireEvent.click(submitButton());
    expect(b.onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-choice-error]')).toHaveTextContent('interaction.issue.choice_required');
    expect(container.querySelector('[data-interaction-error="validation"]')).not.toBeNull();
    // 选择后错误消失
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    expect(container.querySelector('[data-choice-error]')).toBeNull();
  });

  it('multiple: enforces min / max (disables extra options at max)', async () => {
    const b = binding();
    const intent: GenerativeUIIntent = {
      blocks: [
        {
          type: 'choice',
          id: 'm1',
          props: {
            question: '选两个',
            mode: 'multiple',
            minSelect: 2,
            maxSelect: 2,
            options: [
              { id: 'x', label: 'X' },
              { id: 'y', label: 'Y' },
              { id: 'z', label: 'Z' },
            ],
          },
        },
      ],
    };
    const { container } = render(<GenerativeUIRenderer intent={intent} interaction={b} showChrome={false} />);
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]!);
    fireEvent.click(submitButton());
    expect(b.onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-choice-error]')).toHaveTextContent('interaction.issue.choice_too_few');

    fireEvent.click(boxes[2]!);
    expect(screen.getAllByRole('checkbox')[1]).toBeDisabled();
    fireEvent.click(submitButton());
    await waitFor(() => expect(b.onSubmit).toHaveBeenCalledTimes(1));
    expect((b.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![0].data).toEqual({
      m1: { selected: ['x', 'z'] },
    });
  });

  it('allowOther: other text counts as the answer', async () => {
    const b = binding();
    const intent: GenerativeUIIntent = {
      blocks: [
        {
          type: 'choice',
          id: 'o1',
          props: {
            question: '最喜欢的学科',
            allowOther: true,
            options: [
              { id: 'math', label: '数学' },
              { id: 'cs', label: '计算机' },
            ],
          },
        },
      ],
    };
    render(<GenerativeUIRenderer intent={intent} interaction={b} showChrome={false} />);
    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[2]!); // 其他
    fireEvent.change(screen.getByRole('textbox', { name: 'interaction.choice.other' }), {
      target: { value: '  化学 ' },
    });
    fireEvent.click(submitButton());
    await waitFor(() => expect(b.onSubmit).toHaveBeenCalledTimes(1));
    expect((b.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![0].data).toEqual({
      o1: { selected: [], other: '化学' },
    });
  });
});

describe('FormBlock', () => {
  const formIntent: GenerativeUIIntent = {
    blocks: [
      {
        type: 'form',
        id: 'f1',
        props: {
          title: '学习偏好',
          submitLabel: '保存偏好',
          fields: [
            { name: 'goal', label: '目标', kind: 'text', required: true, maxLength: 20 },
            { name: 'hours', label: '每周小时', kind: 'number', min: 1, max: 40, unit: 'h' },
            { name: 'minutes', label: '每日分钟', kind: 'slider', min: 10, max: 60, step: 10 },
            { name: 'level', label: '难度', kind: 'rating', max: 5 },
            { name: 'remind', label: '提醒', kind: 'switch' },
          ],
        },
      },
    ],
  };

  it('collects all five field kinds; uses form submitLabel', async () => {
    const b = binding();
    render(<GenerativeUIRenderer intent={formIntent} interaction={b} showChrome={false} />);
    fireEvent.change(screen.getByLabelText(/目标/), { target: { value: '考研' } });
    fireEvent.change(screen.getByLabelText(/每周小时/), { target: { value: '12' } });
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('radio', { name: 'interaction.form.rating_option:4,5' }));
    fireEvent.click(screen.getByRole('switch'));
    const submit = screen.getByRole('button', { name: /保存偏好/ });
    fireEvent.click(submit);
    await waitFor(() => expect(b.onSubmit).toHaveBeenCalledTimes(1));
    expect((b.onSubmit as ReturnType<typeof vi.fn>).mock.calls[0]![0].data).toEqual({
      f1: { goal: '考研', hours: 12, minutes: 30, level: 4, remind: true },
    });
  });

  it('marks required / out-of-range fields with aria-invalid and inline errors', () => {
    const b = binding();
    const { container } = render(<GenerativeUIRenderer intent={formIntent} interaction={b} showChrome={false} />);
    fireEvent.change(screen.getByLabelText(/每周小时/), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /保存偏好/ }));
    expect(b.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/目标/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/每周小时/)).toHaveAttribute('aria-invalid', 'true');
    expect(container.querySelector('[data-form-field-error="field_required"]')).not.toBeNull();
    expect(container.querySelector('[data-form-field-error="field_out_of_range"]')).toHaveTextContent('1 – 40');
  });
});

describe('InteractionSubmitBar', () => {
  function pickB() {
    fireEvent.click(screen.getAllByRole('radio')[1]!);
  }

  it('ignores untrusted clicks (default activation check)', () => {
    setGenerativeActivationCheckForTests(null); // fireEvent → isTrusted=false
    const b = binding();
    render(<GenerativeUIRenderer intent={singleChoice} interaction={b} showChrome={false} />);
    pickB();
    fireEvent.click(submitButton());
    fireEvent.click(screen.getByRole('button', { name: /interaction\.skip/ }));
    expect(b.onSubmit).not.toHaveBeenCalled();
    expect(b.onSkip).not.toHaveBeenCalled();
  });

  it('double click submits only once and locks after accepted', async () => {
    let resolve!: (v: GenerativeUISubmitOutcome) => void;
    const onSubmit = vi.fn(() => new Promise<GenerativeUISubmitOutcome>((r) => { resolve = r; }));
    const { container } = render(
      <GenerativeUIRenderer intent={singleChoice} interaction={binding({ onSubmit })} showChrome={false} />,
    );
    pickB();
    const btn = submitButton();
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('radio')[0]).toBeDisabled();
    await act(async () => resolve('accepted'));
    expect(container.querySelector('[data-interaction-bar="submitted"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /interaction\.submit/ })).toBeNull();
  });

  it('expired disables everything permanently', async () => {
    const b = binding({ onSubmit: vi.fn(async () => 'expired' as const) });
    const { container } = render(<GenerativeUIRenderer intent={singleChoice} interaction={b} showChrome={false} />);
    pickB();
    fireEvent.click(submitButton());
    await waitFor(() => expect(container.querySelector('[data-interaction-bar="expired"]')).not.toBeNull());
    expect(screen.getByText('interaction.expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /interaction\.submit/ })).toBeNull();
    expect(screen.getAllByRole('radio')[0]).toBeDisabled();
  });

  it('invalid shows the error and allows resubmission', async () => {
    const onSubmit = vi
      .fn<(p: unknown) => Promise<GenerativeUISubmitOutcome>>()
      .mockResolvedValueOnce({ invalid: 'bad option' })
      .mockResolvedValueOnce('accepted');
    const { container } = render(
      <GenerativeUIRenderer intent={singleChoice} interaction={binding({ onSubmit })} showChrome={false} />,
    );
    pickB();
    fireEvent.click(submitButton());
    await waitFor(() => expect(container.querySelector('[data-interaction-error="invalid"]')).not.toBeNull());
    expect(container.querySelector('[data-interaction-error="invalid"]')).toHaveTextContent('bad option');
    expect(submitButton()).not.toBeDisabled();
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('[data-interaction-bar="submitted"]')).not.toBeNull());
  });

  it('rejected onSubmit shows a retryable failure', async () => {
    const onSubmit = vi.fn(async (): Promise<GenerativeUISubmitOutcome> => { throw new Error('ipc'); });
    const { container } = render(
      <GenerativeUIRenderer intent={singleChoice} interaction={binding({ onSubmit })} showChrome={false} />,
    );
    pickB();
    fireEvent.click(submitButton());
    await waitFor(() => expect(container.querySelector('[data-interaction-error="failed"]')).not.toBeNull());
    expect(submitButton()).not.toBeDisabled();
  });

  it('skip calls onSkip once', async () => {
    const b = binding();
    const { container } = render(<GenerativeUIRenderer intent={singleChoice} interaction={b} showChrome={false} />);
    const skip = screen.getByRole('button', { name: /interaction\.skip/ });
    fireEvent.click(skip);
    fireEvent.click(skip);
    await waitFor(() => expect(container.querySelector('[data-interaction-bar="skipped"]')).not.toBeNull());
    expect(b.onSkip).toHaveBeenCalledTimes(1);
    expect(b.onSubmit).not.toHaveBeenCalled();
  });
});

describe('GenerativeUIRenderer interaction modes', () => {
  const handler = (id: string): GenerativeActionDefinition => ({
    id,
    label: id,
    riskLevel: 'low',
    handler: vi.fn(),
  });

  it('display-only filters action handlers to INLINE_SAFE ids and makes choice read-only', () => {
    const intent: GenerativeUIIntent = {
      blocks: [
        ...singleChoice.blocks,
        {
          type: 'action-bar',
          props: {
            actions: [
              { id: 'copy-block', label: '复制' },
              { id: 'apply-note-edit', label: '应用修改' },
              { id: 'open-note:n1', label: '打开笔记' },
            ],
          },
        },
      ],
    };
    const handlers = {
      'copy-block': handler('copy-block'),
      'apply-note-edit': handler('apply-note-edit'),
      'open-note:n1': handler('open-note:n1'),
    };
    const { container } = render(
      <GenerativeUIRenderer intent={intent} interactionMode="display-only" actionHandlers={handlers} showChrome={false} />,
    );
    const toolbar = screen.getByRole('toolbar');
    expect(within(toolbar).getByRole('button', { name: 'copy-block' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'open-note:n1' })).toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: 'apply-note-edit' })).toBeNull();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByText('interaction.display_only')).toBeInTheDocument();
    expect(container.querySelector('[data-interaction-bar]')).toBeNull();
  });

  it('streaming disables actions and interactive blocks; submit bar is a skeleton', () => {
    const run = vi.fn();
    const intent: GenerativeUIIntent = {
      blocks: [
        ...singleChoice.blocks,
        { type: 'action-bar', props: { actions: [{ id: 'copy-block', label: '复制' }] } },
      ],
    };
    const { container } = render(
      <GenerativeUIRenderer
        intent={intent}
        isStreaming
        interaction={binding()}
        actionHandlers={{ 'copy-block': { ...handler('copy-block'), handler: run } }}
        showChrome={false}
      />,
    );
    const button = within(screen.getByRole('toolbar')).getByRole('button', { name: 'copy-block' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(container.querySelector('[data-interaction-bar="streaming"]')).not.toBeNull();
  });

  it('answered replays the answer read-only and replaces the bar with status text', () => {
    const { container } = render(
      <GenerativeUIRenderer
        intent={singleChoice}
        interaction={{
          state: 'answered',
          canSubmit: false,
          answered: { summary: '2+2=?：4', data: { q1: { selected: ['b'] } } },
        }}
        showChrome={false}
      />,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios[1]).toBeChecked();
    expect(radios[1]).toBeDisabled();
    expect(container.querySelector('[data-interaction-status="answered"]')).toHaveTextContent(
      'interaction.answered:2+2=?：4',
    );
    expect(screen.queryByRole('button', { name: /interaction\.submit/ })).toBeNull();
  });

  it.each([
    [{ state: 'dismissed', reason: 'user_message' }, 'interaction.replied_in_chat'],
    [{ state: 'dismissed', reason: 'skipped' }, 'interaction.skipped'],
    [{ state: 'cancelled', reason: 'stopped' }, 'interaction.stopped'],
    [{ state: 'interrupted' }, 'interaction.interrupted'],
  ] as const)('%o → %s', (partial, text) => {
    render(
      <GenerativeUIRenderer
        intent={singleChoice}
        interaction={{ canSubmit: false, ...partial } as GenerativeUIInteractionBinding}
        showChrome={false}
      />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('without a binding interactive blocks are read-only and show the hint', () => {
    render(<GenerativeUIRenderer intent={singleChoice} showChrome={false} />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByText('interaction.display_only')).toBeInTheDocument();
  });
});
