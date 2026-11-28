import type { TFunction } from 'i18next';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { selectionToChat } from '@/features/chat/context/selectionRef';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { getErrorMessage } from '@/utils/errorUtils';
import type { MindMapDocument } from '../../types';
import { findNodeById } from '../../utils/node/find';
import { serializeNodesToOutlineText } from '../../utils/node/outlineText';

export type MindMapAiAction = 'expand' | 'summarize' | 'cloze' | 'ask';

export interface DispatchMindMapAiActionParams {
  action: MindMapAiAction;
  nodeId: string;
  document: MindMapDocument & { title?: string };
  resourceId?: string | null;
  t: TFunction;
}

const PROMPT_KEY_BY_ACTION: Record<
  MindMapAiAction,
  { key: string; defaultValue: string }
> = {
  expand: {
    key: 'mindmap:ai.promptExpand',
    defaultValue:
      '请针对思维导图「{{mapTitle}}」中的节点「{{nodeText}}」（nodeId: {{nodeId}}）进行结构化扩写，直接在该节点下补充 3–5 个关键子节点。',
  },
  summarize: {
    key: 'mindmap:ai.promptSummarize',
    defaultValue:
      '请针对思维导图「{{mapTitle}}」中的节点「{{nodeText}}」（nodeId: {{nodeId}}）及其子树提炼核心要点与结构化总结。',
  },
  cloze: {
    key: 'mindmap:ai.promptCloze',
    defaultValue:
      '请针对思维导图「{{mapTitle}}」中的节点「{{nodeText}}」（nodeId: {{nodeId}}）及其子树，智能识别关键概念并生成背诵挖空建议。',
  },
  ask: {
    key: 'mindmap:ai.promptAsk',
    defaultValue:
      '请深入讲解思维导图「{{mapTitle}}」中的知识点「{{nodeText}}」（nodeId: {{nodeId}}），结合核心原理、直观例子与易错点说明。',
  },
};

/**
 * 思维导图原生 AI 一键操作统一分发器（CanvasContextMenu / FormatBar / OutlineNodeMenu 共用）。
 *
 * 闭环流程：
 * 1. 提取目标节点及其子树文本摘要，调用 `selectionToChat(..., { silent: true })` 挂载精确上下文引用；
 * 2. 组装结构化指令（含导图标题、节点文本、节点 ID），通过 `PREFILL_CHAT_INPUT` 呼出/预填对话输入；
 * 3. 提供清晰反馈并安全捕获异常。
 */
export async function dispatchMindMapAiAction({
  action,
  nodeId,
  document,
  resourceId,
  t,
}: DispatchMindMapAiActionParams): Promise<boolean> {
  try {
    const targetNode = findNodeById(document.root, nodeId);
    if (!targetNode) {
      showGlobalNotification(
        'warning',
        t('mindmap:ai.nodeNotFound', {
          defaultValue: '未找到目标节点，无法发起 AI 操作',
        }),
      );
      return false;
    }

    const mapTitle =
      document.title?.trim() ||
      document.root.text?.trim() ||
      t('mindmap:outline.untitled', { defaultValue: '无标题' });
    const nodeText =
      targetNode.text?.trim() ||
      t('mindmap:outline.unnamedNode', { defaultValue: '未命名节点' });

    const outlineSummary =
      serializeNodesToOutlineText([targetNode], {
        maxDepth: 4,
        maxNodes: 40,
        maxNoteChars: 240,
      }).trim() || nodeText;

    const sourceId = resourceId?.trim() || undefined;
    await selectionToChat({
      text: outlineSummary,
      source: {
        kind: 'mindmap',
        ...(sourceId ? { sourceId } : {}),
        locator: `node:${nodeId}`,
        title: mapTitle,
      },
      silent: true,
    });

    const promptSpec = PROMPT_KEY_BY_ACTION[action];
    const prompt = t(promptSpec.key, {
      defaultValue: promptSpec.defaultValue,
      mapTitle,
      nodeText,
      nodeId,
    });

    if (workbenchBus.isEnabled()) {
      workbenchBus.launch({ typeId: 'chat', placement: { mode: 'beside' }, reason: 'command' });
    }

    dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
      content: prompt,
      autoSend: false,
    });

    showGlobalNotification(
      'success',
      t('mindmap:ai.actionDispatched', {
        defaultValue: '已将节点上下文与指令预填至 AI 对话',
      }),
    );
    return true;
  } catch (error: unknown) {
    showGlobalNotification(
      'error',
      t('mindmap:ai.actionFailed', {
        defaultValue: '发起 AI 操作失败：{{error}}',
        error: getErrorMessage(error),
      }),
    );
    return false;
  }
}
