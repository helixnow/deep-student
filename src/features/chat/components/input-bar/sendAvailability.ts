/**
 * 发送可用性 selector：把 InputBarUI 里散落的 6 个 disabledSend 条件
 * 收敛为「禁用 + 原因码 + 本地化原因」的单一出口。
 *
 * 6 个条件（按原因展示优先级排序）：
 * 1. queueFull                — 队列已满
 * 2. externalReason           — 宿主传入的 disabledReason（如权限/模型不可用）
 * 3. hasUploadingAttachments  — 附件上传中
 * 4. 附件处理未就绪            — hasProcessingMedia / firstBlockingAttachment
 * 5. 无可发送内容              — 没有文本也没有可发送附件
 * 6. !canSubmit               — 非 idle 且不可入队（流式中且队列关闭）
 *
 * 特例：流式输出中展示 Stop 按钮（showStop）时发送按钮不可见，
 * 一律视为「不禁用」，与原实现一致。
 */

import type { TFunction } from 'i18next';

export type SendBlockCode =
  | 'queue-full'
  | 'external'
  | 'uploading'
  | 'attachment-not-ready'
  | 'empty'
  | 'busy';

export interface BlockingAttachmentInfo {
  name: string;
  /** 已本地化的缺失模式列表；空字符串表示无模式明细（仅展示「处理中」） */
  missingModesLabel: string;
}

export interface SendAvailabilityInput {
  /** 流式中展示 Stop（发送按钮隐藏），禁用判定短路为 false */
  showStop: boolean;
  queueFull: boolean;
  /** 宿主传入的外部禁用原因（已本地化） */
  externalReason?: string;
  hasUploadingAttachments: boolean;
  hasProcessingMedia: boolean;
  firstBlockingAttachment: BlockingAttachmentInfo | null;
  /** 有非空文本或有可发送附件 */
  hasSendableContent: boolean;
  /** idle 或队列模式可入队 */
  canSubmit: boolean;
}

export interface SendAvailability {
  disabled: boolean;
  code: SendBlockCode | null;
}

export function computeSendAvailability(input: SendAvailabilityInput): SendAvailability {
  if (input.showStop) {
    return { disabled: false, code: null };
  }
  if (input.queueFull) {
    return { disabled: true, code: 'queue-full' };
  }
  if (input.externalReason) {
    return { disabled: true, code: 'external' };
  }
  if (input.hasUploadingAttachments) {
    return { disabled: true, code: 'uploading' };
  }
  if (input.hasProcessingMedia || input.firstBlockingAttachment) {
    return { disabled: true, code: 'attachment-not-ready' };
  }
  if (!input.hasSendableContent) {
    return { disabled: true, code: 'empty' };
  }
  if (!input.canSubmit) {
    return { disabled: true, code: 'busy' };
  }
  return { disabled: false, code: null };
}

/**
 * 原因码 → 本地化原因文本。
 * 与旧 sendBlockedReason 逐字一致（queue-full / external / uploading /
 * attachment-not-ready），并为 empty / busy 补充新文案。
 */
export function resolveSendBlockedReason(
  t: TFunction,
  code: SendBlockCode | null,
  ctx: Pick<SendAvailabilityInput, 'externalReason' | 'firstBlockingAttachment'>,
): string | undefined {
  switch (code) {
    case 'queue-full':
      return t('chatV2:queue.fullTooltip');
    case 'external':
      return ctx.externalReason;
    case 'uploading':
      return t('chatV2:inputBar.attachmentsUploading');
    case 'attachment-not-ready': {
      const blocking = ctx.firstBlockingAttachment;
      if (!blocking) return t('chatV2:inputBar.processingIndicator');
      return blocking.missingModesLabel
        ? t('chatV2:inputBar.attachmentNotReady', {
            name: blocking.name,
            modes: blocking.missingModesLabel,
          })
        : t('chatV2:inputBar.attachmentProcessing', {
            name: blocking.name,
          });
    }
    case 'empty':
      return t('chatV2:inputBar.sendBlockedEmpty');
    case 'busy':
      return t('chatV2:inputBar.sendBlockedBusy');
    default:
      return undefined;
  }
}

/**
 * 输入区内联提示：只提示「用户等一等/换个动作就能解除」的阻塞原因。
 * empty 是常驻默认态，在输入区常显提示反成噪音，交给按钮置灰表达。
 */
export function resolveInlineSendHint(
  t: TFunction,
  availability: SendAvailability,
  ctx: Pick<SendAvailabilityInput, 'externalReason' | 'firstBlockingAttachment'>,
): string | undefined {
  if (!availability.disabled || availability.code === 'empty' || availability.code === null) {
    return undefined;
  }
  return resolveSendBlockedReason(t, availability.code, ctx);
}
