import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  computeSendAvailability,
  resolveSendBlockedReason,
  resolveInlineSendHint,
  type SendAvailabilityInput,
} from '../sendAvailability';

// 假 t：返回 key（含插值参数便于断言）
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}|${JSON.stringify(params)}` : key) as unknown as TFunction;

function baseInput(overrides: Partial<SendAvailabilityInput> = {}): SendAvailabilityInput {
  return {
    showStop: false,
    queueFull: false,
    externalReason: undefined,
    hasUploadingAttachments: false,
    hasProcessingMedia: false,
    firstBlockingAttachment: null,
    hasSendableContent: true,
    canSubmit: true,
    ...overrides,
  };
}

describe('computeSendAvailability', () => {
  it('returns enabled with no code when nothing blocks', () => {
    expect(computeSendAvailability(baseInput())).toEqual({ disabled: false, code: null });
  });

  it('short-circuits to enabled when showStop is on, even if other blocks apply', () => {
    // 流式中发送按钮被 Stop 替换，禁用态无意义（与旧实现一致）
    expect(
      computeSendAvailability(
        baseInput({
          showStop: true,
          queueFull: true,
          hasUploadingAttachments: true,
          hasSendableContent: false,
          canSubmit: false,
        }),
      ),
    ).toEqual({ disabled: false, code: null });
  });

  it('maps each of the six conditions to its code', () => {
    expect(computeSendAvailability(baseInput({ queueFull: true })).code).toBe('queue-full');
    expect(computeSendAvailability(baseInput({ externalReason: '模型不可用' })).code).toBe('external');
    expect(computeSendAvailability(baseInput({ hasUploadingAttachments: true })).code).toBe('uploading');
    expect(computeSendAvailability(baseInput({ hasProcessingMedia: true })).code).toBe('attachment-not-ready');
    expect(
      computeSendAvailability(
        baseInput({ firstBlockingAttachment: { name: 'a.pdf', missingModesLabel: '' } }),
      ).code,
    ).toBe('attachment-not-ready');
    expect(computeSendAvailability(baseInput({ hasSendableContent: false })).code).toBe('empty');
    expect(computeSendAvailability(baseInput({ canSubmit: false })).code).toBe('busy');
  });

  it('every blocking code implies disabled: true', () => {
    const blockedInputs: Array<Partial<SendAvailabilityInput>> = [
      { queueFull: true },
      { externalReason: 'x' },
      { hasUploadingAttachments: true },
      { hasProcessingMedia: true },
      { hasSendableContent: false },
      { canSubmit: false },
    ];
    for (const overrides of blockedInputs) {
      expect(computeSendAvailability(baseInput(overrides)).disabled).toBe(true);
    }
  });

  it('respects display priority: queueFull > external > uploading > not-ready > empty > busy', () => {
    // 全阻塞时取最高优先级
    const all = baseInput({
      queueFull: true,
      externalReason: 'x',
      hasUploadingAttachments: true,
      hasProcessingMedia: true,
      hasSendableContent: false,
      canSubmit: false,
    });
    expect(computeSendAvailability(all).code).toBe('queue-full');
    expect(computeSendAvailability({ ...all, queueFull: false }).code).toBe('external');
    expect(computeSendAvailability({ ...all, queueFull: false, externalReason: undefined }).code).toBe('uploading');
    expect(
      computeSendAvailability({
        ...all,
        queueFull: false,
        externalReason: undefined,
        hasUploadingAttachments: false,
      }).code,
    ).toBe('attachment-not-ready');
    expect(
      computeSendAvailability({
        ...all,
        queueFull: false,
        externalReason: undefined,
        hasUploadingAttachments: false,
        hasProcessingMedia: false,
      }).code,
    ).toBe('empty');
    expect(
      computeSendAvailability({
        ...all,
        queueFull: false,
        externalReason: undefined,
        hasUploadingAttachments: false,
        hasProcessingMedia: false,
        hasSendableContent: true,
      }).code,
    ).toBe('busy');
  });
});

describe('resolveSendBlockedReason', () => {
  const emptyCtx = { externalReason: undefined, firstBlockingAttachment: null };

  it('returns undefined for null code (enabled state)', () => {
    expect(resolveSendBlockedReason(t, null, emptyCtx)).toBeUndefined();
  });

  it('maps codes to localized strings', () => {
    expect(resolveSendBlockedReason(t, 'queue-full', emptyCtx)).toBe('chatV2:queue.fullTooltip');
    expect(resolveSendBlockedReason(t, 'uploading', emptyCtx)).toBe('chatV2:inputBar.attachmentsUploading');
    expect(resolveSendBlockedReason(t, 'empty', emptyCtx)).toBe('chatV2:inputBar.sendBlockedEmpty');
    expect(resolveSendBlockedReason(t, 'busy', emptyCtx)).toBe('chatV2:inputBar.sendBlockedBusy');
  });

  it('passes the external reason through verbatim', () => {
    expect(
      resolveSendBlockedReason(t, 'external', { ...emptyCtx, externalReason: '当前模型不可用' }),
    ).toBe('当前模型不可用');
  });

  it('renders attachment-not-ready with mode details when available', () => {
    expect(
      resolveSendBlockedReason(t, 'attachment-not-ready', {
        externalReason: undefined,
        firstBlockingAttachment: { name: '讲义.pdf', missingModesLabel: '文本、图像' },
      }),
    ).toBe('chatV2:inputBar.attachmentNotReady|{"name":"讲义.pdf","modes":"文本、图像"}');
  });

  it('falls back to plain processing copy without mode details', () => {
    expect(
      resolveSendBlockedReason(t, 'attachment-not-ready', {
        externalReason: undefined,
        firstBlockingAttachment: { name: '讲义.pdf', missingModesLabel: '' },
      }),
    ).toBe('chatV2:inputBar.attachmentProcessing|{"name":"讲义.pdf"}');
  });

  it('falls back to generic indicator when no blocking attachment info exists', () => {
    expect(resolveSendBlockedReason(t, 'attachment-not-ready', emptyCtx)).toBe(
      'chatV2:inputBar.processingIndicator',
    );
  });
});

describe('resolveInlineSendHint', () => {
  const emptyCtx = { externalReason: undefined, firstBlockingAttachment: null };

  it('returns undefined when not disabled', () => {
    expect(resolveInlineSendHint(t, { disabled: false, code: null }, emptyCtx)).toBeUndefined();
  });

  it('suppresses the hint for the empty state (default resting state)', () => {
    expect(resolveInlineSendHint(t, { disabled: true, code: 'empty' }, emptyCtx)).toBeUndefined();
  });

  it('shows waiting-resolvable reasons inline', () => {
    expect(resolveInlineSendHint(t, { disabled: true, code: 'uploading' }, emptyCtx)).toBe(
      'chatV2:inputBar.attachmentsUploading',
    );
    expect(resolveInlineSendHint(t, { disabled: true, code: 'busy' }, emptyCtx)).toBe(
      'chatV2:inputBar.sendBlockedBusy',
    );
    expect(
      resolveInlineSendHint(t, { disabled: true, code: 'external' }, {
        ...emptyCtx,
        externalReason: '权限不足',
      }),
    ).toBe('权限不足');
  });
});
