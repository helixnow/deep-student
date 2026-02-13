/**
 * Anki 流事件处理服务
 *
 * 处理从后端接收的 Anki 生成事件，解析并转换为状态更新
 */

import type { AnkiCard } from '@/types';
import type {
  DocumentTaskUI,
  AnkiStreamEventPayload,
  DocumentProcessingStartedData,
  TaskStatusUpdateData,
  CardStreamingData,
  TaskCompletedData,
  GenerationCompletedData,
} from '../types';

/**
 * 事件处理结果类型
 */
export type StreamEventAction =
  | { type: 'DOCUMENT_STARTED'; payload: { documentId: string; tasks: DocumentTaskUI[] } }
  | { type: 'TASK_UPDATED'; payload: { taskId: string; segmentIndex: number; status: string; progress?: number } }
  | { type: 'CARD_ADDED'; payload: { taskId: string; card: AnkiCard } }
  | { type: 'TASK_COMPLETED'; payload: { taskId: string; cards: AnkiCard[] } }
  | { type: 'GENERATION_COMPLETED'; payload: { documentId: string } }
  | { type: 'GENERATION_PAUSED'; payload: { documentId: string } }
  | { type: 'GENERATION_CANCELLED'; payload: { documentId: string } }
  | { type: 'GENERATION_ERROR'; payload: { error: string } }
  | { type: 'UNKNOWN'; payload: unknown };

/**
 * 创建初始任务列表
 *
 * @param documentId - 文档 ID
 * @param totalSegments - 总段数
 * @param templateId - 模板 ID（可选）
 * @returns 初始任务列表
 */
export function createInitialTasks(
  documentId: string,
  totalSegments: number,
  templateId?: string,
): DocumentTaskUI[] {
  return Array.from({ length: totalSegments }, (_, index) => ({
    task_id: `${documentId}_task_${index}`,
    segment_index: index,
    status: 'pending' as const,
    progress: 0,
    cards: [],
    template_id: templateId || null,
  }));
}

/**
 * 解析流事件载荷
 *
 * @param rawPayload - 原始事件载荷
 * @returns 解析后的事件载荷
 */
export function parseStreamEvent(rawPayload: unknown): AnkiStreamEventPayload | null {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null;
  }

  const payload = rawPayload as Record<string, unknown>;

  // 尝试从不同的事件格式中提取类型
  let eventType: string | undefined;
  let eventData: Record<string, unknown> = {};

  // 格式1: { type: 'EventType', data: {...} }
  if (typeof payload.type === 'string') {
    eventType = payload.type;
    eventData = (payload.data as Record<string, unknown>) || {};
  }
  // 格式2: { EventType: {...} }
  else {
    const keys = Object.keys(payload);
    if (keys.length > 0) {
      eventType = keys[0];
      eventData = (payload[eventType] as Record<string, unknown>) || {};
    }
  }

  if (!eventType) {
    return null;
  }

  return {
    type: eventType as AnkiStreamEventPayload['type'],
    data: eventData,
  };
}

/**
 * 验证 DocumentProcessingStartedData
 */
function isDocumentProcessingStartedData(data: unknown): data is DocumentProcessingStartedData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.document_id === 'string' && typeof obj.total_segments === 'number';
}

/**
 * 验证 TaskStatusUpdateData
 */
function isTaskStatusUpdateData(data: unknown): data is TaskStatusUpdateData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    (typeof obj.task_id === 'string' || obj.task_id === undefined) &&
    (typeof obj.segment_index === 'number' || obj.segment_index === undefined) &&
    typeof obj.status === 'string'
  );
}

/**
 * 验证 CardStreamingData
 */
function isCardStreamingData(data: unknown): data is CardStreamingData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return obj.card !== null && typeof obj.card === 'object';
}

/**
 * 处理流事件并返回操作
 *
 * @param event - 解析后的事件
 * @param currentDocumentId - 当前文档 ID
 * @returns 状态更新操作
 */
export function handleStreamEvent(
  event: AnkiStreamEventPayload,
  currentDocumentId: string | null,
): StreamEventAction {
  const { type, data } = event;

  try {
    switch (type) {
      case 'DocumentProcessingStarted': {
        if (!isDocumentProcessingStartedData(data)) {
          console.error('Invalid DocumentProcessingStarted data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        const tasks = createInitialTasks(
          data.document_id,
          data.total_segments,
        );
        return {
          type: 'DOCUMENT_STARTED',
          payload: {
            documentId: data.document_id,
            tasks,
          },
        };
      }

      case 'TaskStatusUpdate': {
        if (!isTaskStatusUpdateData(data)) {
          console.error('Invalid TaskStatusUpdate data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        const taskId = data.task_id || `${currentDocumentId}_task_${data.segment_index ?? 0}`;
        return {
          type: 'TASK_UPDATED',
          payload: {
            taskId,
            segmentIndex: data.segment_index ?? 0,
            status: data.status,
            progress: data.progress,
          },
        };
      }

      case 'CardStreaming': {
        if (!isCardStreamingData(data)) {
          console.error('Invalid CardStreaming data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        const taskId = data.task_id || `${currentDocumentId}_task_${data.segment_index ?? 0}`;
        return {
          type: 'CARD_ADDED',
          payload: {
            taskId,
            card: data.card,
          },
        };
      }

      case 'TaskCompleted': {
        const completedData = data as unknown as TaskCompletedData;
        if (!completedData || typeof completedData !== 'object' || typeof completedData.task_id !== 'string') {
          console.error('Invalid TaskCompleted data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        return {
          type: 'TASK_COMPLETED',
          payload: {
            taskId: completedData.task_id,
            cards: Array.isArray(completedData.cards) ? completedData.cards : [],
          },
        };
      }

      case 'GenerationCompleted': {
        const completedData = data as unknown as GenerationCompletedData;
        if (!completedData || typeof completedData !== 'object' || typeof completedData.document_id !== 'string') {
          console.error('Invalid GenerationCompleted data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        return {
          type: 'GENERATION_COMPLETED',
          payload: {
            documentId: completedData.document_id,
          },
        };
      }

      case 'GenerationPaused': {
        const pausedData = data as unknown as { document_id: string };
        if (!pausedData || typeof pausedData !== 'object' || typeof pausedData.document_id !== 'string') {
          console.error('Invalid GenerationPaused data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        return {
          type: 'GENERATION_PAUSED',
          payload: {
            documentId: pausedData.document_id,
          },
        };
      }

      case 'GenerationCancelled': {
        const cancelledData = data as unknown as { document_id: string };
        if (!cancelledData || typeof cancelledData !== 'object' || typeof cancelledData.document_id !== 'string') {
          console.error('Invalid GenerationCancelled data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        return {
          type: 'GENERATION_CANCELLED',
          payload: {
            documentId: cancelledData.document_id,
          },
        };
      }

      case 'GenerationError': {
        const errorData = data as unknown as { error?: string; message?: string };
        if (!errorData || typeof errorData !== 'object') {
          console.error('Invalid GenerationError data:', data);
          return { type: 'UNKNOWN', payload: data };
        }
        return {
          type: 'GENERATION_ERROR',
          payload: {
            error: (typeof errorData.error === 'string' ? errorData.error : null) ||
                   (typeof errorData.message === 'string' ? errorData.message : null) ||
                   'Unknown error',
          },
        };
      }

      default:
        return { type: 'UNKNOWN', payload: data };
    }
  } catch (error: unknown) {
    console.error('Error handling stream event:', error, event);
    return {
      type: 'GENERATION_ERROR',
      payload: { error: error instanceof Error ? error.message : 'Event processing failed' }
    };
  }
}

/**
 * 更新任务状态
 *
 * @param tasks - 当前任务列表
 * @param taskId - 任务 ID
 * @param updates - 更新内容
 * @returns 更新后的任务列表
 */
export function updateTaskInList(
  tasks: DocumentTaskUI[],
  taskId: string,
  updates: Partial<DocumentTaskUI>,
): DocumentTaskUI[] {
  return tasks.map((task) =>
    task.task_id === taskId ? { ...task, ...updates } : task
  );
}

/**
 * 通过段索引更新任务
 *
 * @param tasks - 当前任务列表
 * @param segmentIndex - 段索引
 * @param updates - 更新内容
 * @returns 更新后的任务列表
 */
export function updateTaskBySegmentIndex(
  tasks: DocumentTaskUI[],
  segmentIndex: number,
  updates: Partial<DocumentTaskUI>,
): DocumentTaskUI[] {
  return tasks.map((task) =>
    task.segment_index === segmentIndex ? { ...task, ...updates } : task
  );
}

/**
 * 添加卡片到任务
 *
 * @param tasks - 当前任务列表
 * @param taskId - 任务 ID
 * @param card - 要添加的卡片
 * @returns 更新后的任务列表
 */
export function addCardToTask(
  tasks: DocumentTaskUI[],
  taskId: string,
  card: AnkiCard,
): DocumentTaskUI[] {
  return tasks.map((task) => {
    if (task.task_id === taskId) {
      // 检查重复
      const isDuplicate = task.cards.some(
        (c) => c.front === card.front && c.back === card.back
      );
      if (isDuplicate) {
        return task;
      }
      return {
        ...task,
        cards: [...task.cards, card],
      };
    }
    return task;
  });
}

/**
 * 计算整体进度
 *
 * @param tasks - 任务列表
 * @returns 0-100 的进度值
 */
export function calculateOverallProgress(tasks: DocumentTaskUI[]): number {
  if (tasks.length === 0) return 0;

  const completedTasks = tasks.filter(
    (t) => t.status === 'completed' || t.status === 'failed'
  ).length;

  return Math.round((completedTasks / tasks.length) * 100);
}
