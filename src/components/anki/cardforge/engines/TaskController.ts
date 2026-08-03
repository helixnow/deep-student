/**
 * TaskController - 任务控制器
 *
 * 职责：管理任务生命周期，提供暂停/恢复/重试/取消能力
 *
 * 设计原则：
 * - 前端不维护任务状态，状态全部由后端 DOCUMENT_STATES 管理
 * - 前端只负责调用后端命令和返回结果
 * - 所有操作都是幂等的，可以安全重复调用
 *
 * 状态机（后端管理）：
 * ```
 * PENDING → PROCESSING → COMPLETED
 *            ↓    ↑        ↑
 *          pause resume   retry
 *            ↓    ↑        ↑
 *          PAUSED      FAILED
 * ```
 *
 * 与后端命令对接：
 * | 前端操作 | 后端命令 | 说明 |
 * |----------|----------|------|
 * | 暂停 | pause_document_processing | 标记暂停，取消当前流 |
 * | 恢复 | resume_document_processing | 继续 Paused/Pending 任务 |
 * | 重试单个 | trigger_task_processing | 重新处理指定任务 |
 * | 取消 | cancel_document_processing | 仅停止生成，保留已生成卡片 |
 * | 查询状态 | get_document_tasks | 获取所有任务状态 |
 *
 * @module TaskController
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '@/utils/i18n';
import { isFailedLikeTaskStatus, normalizeTaskStatus } from './taskStatus';
import type {
  ControlTaskInput,
  ControlTaskOutput,
  TaskInfo,
  TaskStatus,
} from '../types';

/** anki 命名空间下 engine 子对象的 i18n 快捷函数 */
const tEngine = (key: string, options?: Record<string, unknown>): string =>
  t(`engine.${key}`, options, 'anki');

/**
 * 后端返回的文档状态
 */
interface DocumentState {
  status: 'pending' | 'processing' | 'paused' | 'completed' | 'failed' | 'cancelled';
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  paused_tasks: number;
}

/**
 * 后端任务数据结构（来自 enhanced_anki_service.rs）
 */
interface BackendTask {
  id?: string;
  task_id?: string;
  segment_index: number;
  status: TaskStatus | string;
  cards_generated?: number;
  error_message?: string | null;
  is_retry?: boolean;
  content_preview?: string;
}

/**
 * TaskController 类
 *
 * 提供文档级别和任务级别的控制操作
 */
export class TaskController {
  /**
   * 进行中的控制操作（按 `${action}:${documentId}` 去重）。
   *
   * 竞态防护：暂停/恢复/取消按钮被快速连点时，同一操作只会向后端发出
   * 一次命令，后续调用复用同一个 Promise，避免命令交叠导致后端状态抖动。
   * 不同 action 之间不互斥（后端命令本身幂等，由后端状态机裁决）。
   */
  private inflightOps = new Map<string, Promise<ControlTaskOutput>>();

  /**
   * 以去重方式执行控制操作：同 key 的并发调用共享同一个 Promise。
   */
  private async runExclusive(
    key: string,
    run: () => Promise<ControlTaskOutput>,
  ): Promise<ControlTaskOutput> {
    const existing = this.inflightOps.get(key);
    if (existing) {
      return existing;
    }
    const task = run().finally(() => {
      this.inflightOps.delete(key);
    });
    this.inflightOps.set(key, task);
    return task;
  }

  /**
   * 暂停文档处理
   *
   * 调用后端 pause_document_processing 命令，将文档标记为暂停状态
   * 后端会取消当前正在执行的流式任务
   *
   * @param documentId 文档 ID
   * @returns 操作结果
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const result = await controller.pause('doc-123');
   * if (result.ok) {
   *   console.log('暂停成功:', result.message);
   * }
   * ```
   */
  async pause(documentId: string): Promise<ControlTaskOutput> {
    // 参数验证
    if (!documentId || documentId.trim() === '') {
      return {
        ok: false,
        message: tEngine('document_id_required'),
      };
    }

    return this.runExclusive(`pause:${documentId.trim()}`, async () => {
      try {
        // 调用后端暂停命令
        await invoke<void>('pause_document_processing', {
          documentId: documentId.trim(),
        });

        // 获取更新后的任务状态
        const tasks = await this.getTaskStatus(documentId);

        return {
          ok: true,
          message: tEngine('pause_success'),
          tasks,
        };
      } catch (error: unknown) {
        // 错误处理
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);

        console.error(`[TaskController] 暂停文档失败 (documentId: ${documentId}):`, error);

        return {
          ok: false,
          message: tEngine('pause_failed', { error: errorMessage }),
        };
      }
    });
  }

  /**
   * 恢复文档处理
   *
   * 调用后端 resume_document_processing 命令，恢复暂停的文档
   * 后端会继续处理 Paused 和 Pending 状态的任务
   *
   * @param documentId 文档 ID
   * @returns 操作结果，包含恢复后的任务列表
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const result = await controller.resume('doc-123');
   * if (result.ok && result.tasks) {
   *   console.log('恢复了', result.tasks.length, '个任务');
   * }
   * ```
   */
  async resume(documentId: string): Promise<ControlTaskOutput> {
    // 参数验证
    if (!documentId || documentId.trim() === '') {
      return {
        ok: false,
        message: tEngine('document_id_required'),
      };
    }

    return this.runExclusive(`resume:${documentId.trim()}`, async () => {
      try {
        // 调用后端恢复命令
        await invoke<void>('resume_document_processing', {
          documentId: documentId.trim(),
        });

        // 获取更新后的任务状态
        const tasks = await this.getTaskStatus(documentId);

        return {
          ok: true,
          message: tEngine('resume_success'),
          tasks,
        };
      } catch (error: unknown) {
        // 错误处理
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);

        console.error(`[TaskController] 恢复文档失败 (documentId: ${documentId}):`, error);

        return {
          ok: false,
          message: tEngine('resume_failed', { error: errorMessage }),
        };
      }
    });
  }

  /**
   * 重试单个任务
   *
   * 调用后端 trigger_task_processing 命令，重新处理指定的任务
   * 通常用于处理失败的任务
   *
   * @param documentId 文档 ID
   * @param taskId 任务 ID
   * @returns 操作结果
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const result = await controller.retry('doc-123', 'task-456');
   * if (result.ok) {
   *   console.log('任务已重新提交:', result.message);
   * }
   * ```
   */
  async retry(documentId: string, taskId: string): Promise<ControlTaskOutput> {
    // 参数验证
    if (!documentId || documentId.trim() === '') {
      return {
        ok: false,
        message: tEngine('document_id_required'),
      };
    }

    if (!taskId || taskId.trim() === '') {
      return {
        ok: false,
        message: tEngine('task_id_required'),
      };
    }

    return this.runExclusive(`retry:${documentId.trim()}:${taskId.trim()}`, async () => {
      try {
        // 调用后端重试命令（Tauri v2 默认参数 key 为 camelCase）
        await invoke<void>('trigger_task_processing', {
          taskId: taskId.trim(),
        });

        // 获取更新后的任务状态
        const tasks = await this.getTaskStatus(documentId);

        return {
          ok: true,
          message: tEngine('retry_submitted', { taskId }),
          tasks,
        };
      } catch (error: unknown) {
        // 错误处理
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);

        console.error(`[TaskController] 重试任务失败 (documentId: ${documentId}, taskId: ${taskId}):`, error);

        return {
          ok: false,
          message: tEngine('retry_failed', { error: errorMessage }),
        };
      }
    });
  }

  /**
   * 取消文档处理（非破坏性）
   *
   * 调用后端 cancel_document_processing 命令：仅停止生成，
   * 未完成任务标记为 Cancelled，已生成的任务与卡片全部保留。
   * 如需删除整个会话（含卡片），请使用 delete_document_session。
   *
   * @param documentId 文档 ID
   * @returns 操作结果
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const result = await controller.cancel('doc-123');
   * if (result.ok) {
   *   console.log('文档处理已取消');
   * }
   * ```
   */
  async cancel(documentId: string): Promise<ControlTaskOutput> {
    // 参数验证
    if (!documentId || documentId.trim() === '') {
      return {
        ok: false,
        message: tEngine('document_id_required'),
      };
    }

    return this.runExclusive(`cancel:${documentId.trim()}`, async () => {
      try {
        // 仅停止生成：后端断开运行中的流、将未完成任务置为 Cancelled，
        // 保留已生成的卡片（非破坏性取消）
        await invoke<void>('cancel_document_processing', {
          documentId: documentId.trim(),
        });

        return {
          ok: true,
          message: tEngine('cancel_success'),
        };
      } catch (error: unknown) {
        // 错误处理
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);

        console.error(`[TaskController] 取消文档失败 (documentId: ${documentId}):`, error);

        return {
          ok: false,
          message: tEngine('cancel_failed', { error: errorMessage }),
        };
      }
    });
  }

  /**
   * 获取任务状态列表
   *
   * 调用后端 get_document_tasks 命令，获取文档的所有任务状态
   *
   * @param documentId 文档 ID
   * @returns 任务信息列表
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const tasks = await controller.getTaskStatus('doc-123');
   * tasks.forEach(task => {
   *   console.log(`任务 ${task.taskId}: ${task.status}`);
   * });
   * ```
   */
  async getTaskStatus(documentId: string): Promise<TaskInfo[]> {
    try {
      // 参数验证
      if (!documentId || documentId.trim() === '') {
        console.warn('[TaskController] getTaskStatus: 文档 ID 为空');
        return [];
      }

      // 调用后端查询命令
      const backendTasks = await invoke<BackendTask[]>('get_document_tasks', {
        documentId: documentId.trim(),
      });

      // 转换后端数据结构到前端 TaskInfo
      const tasks: TaskInfo[] = [];
      for (const task of backendTasks) {
        const taskId = this.resolveTaskId(task);
        if (!taskId) {
          console.warn('[TaskController] getTaskStatus: 任务缺少 task_id/id');
          continue;
        }
        tasks.push({
          taskId,
          segmentIndex: task.segment_index,
          status: this.normalizeStatus(task.status),
          cardsGenerated: task.cards_generated ?? 0,
          errorMessage: task.error_message ?? undefined,
        });
      }

      return tasks;
    } catch (error: unknown) {
      // 错误处理 - 查询失败时返回空数组而不是抛异常
      console.error(`[TaskController] 获取任务状态失败 (documentId: ${documentId}):`, error);
      return [];
    }
  }

  private resolveTaskId(task: BackendTask): string | null {
    if (typeof task.task_id === 'string' && task.task_id.trim() !== '') {
      return task.task_id.trim();
    }
    if (typeof task.id === 'string' && task.id.trim() !== '') {
      return task.id.trim();
    }
    return null;
  }

  private normalizeStatus(status: BackendTask['status']): TaskStatus {
    // 统一走大小写不敏感的共享归一化工具（见 ./taskStatus.ts）
    return normalizeTaskStatus(status);
  }

  /**
   * 获取文档状态
   *
   * 调用后端 get_document_processing_state 命令（如果可用），获取文档的整体状态
   * 包括总任务数、完成数、失败数等统计信息
   *
   * @param documentId 文档 ID
   * @returns 文档状态
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const state = await controller.getDocumentState('doc-123');
   * console.log(`进度: ${state.completed_tasks}/${state.total_tasks}`);
   * ```
   */
  async getDocumentState(documentId: string): Promise<DocumentState> {
    try {
      // 参数验证
      if (!documentId || documentId.trim() === '') {
        return {
          status: 'pending',
          total_tasks: 0,
          completed_tasks: 0,
          failed_tasks: 0,
          paused_tasks: 0,
        };
      }

      const trimmedId = documentId.trim();

      // 文档级状态同样可能是帕斯卡命名（'Paused' 等），统一归一为小写，
      // 避免 canResume/isProcessing 的等值比较因大小写漏判
      const normalizeDocState = (state: DocumentState): DocumentState => ({
        ...state,
        status: normalizeTaskStatus(state.status) as DocumentState['status'],
      });

      try {
        // 优先使用最新命令名
        return normalizeDocState(await invoke<DocumentState>('get_document_processing_state', {
          documentId: trimmedId,
        }));
      } catch (error: unknown) {
        // 兼容旧命令名
        return normalizeDocState(await invoke<DocumentState>('get_document_state', {
          documentId: trimmedId,
        }));
      }
    } catch (error: unknown) {
      // 如果后端未实现该命令，尝试从任务列表推导状态
      console.warn('[TaskController] get_document_processing_state 未实现，从任务列表推导状态');

      try {
        const tasks = await this.getTaskStatus(documentId);

        // 统计各状态任务数
        const totalTasks = tasks.length;
        const completedTasks = tasks.filter(t => t.status === 'completed').length;
        const failedTasks = tasks.filter(t => t.status === 'failed').length;
        const pausedTasks = tasks.filter(t => t.status === 'paused').length;
        const processingTasks = tasks.filter(t =>
          t.status === 'processing' || t.status === 'streaming'
        ).length;

        // 推导文档状态
        let status: DocumentState['status'] = 'pending';
        if (completedTasks === totalTasks && totalTasks > 0) {
          status = 'completed';
        } else if (failedTasks === totalTasks && totalTasks > 0) {
          status = 'failed';
        } else if (pausedTasks > 0) {
          status = 'paused';
        } else if (processingTasks > 0) {
          status = 'processing';
        }

        return {
          status,
          total_tasks: totalTasks,
          completed_tasks: completedTasks,
          failed_tasks: failedTasks,
          paused_tasks: pausedTasks,
        };
      } catch (fallbackError: unknown) {
        console.error('[TaskController] 推导文档状态失败:', fallbackError);

        return {
          status: 'pending',
          total_tasks: 0,
          completed_tasks: 0,
          failed_tasks: 0,
          paused_tasks: 0,
        };
      }
    }
  }

  /**
   * 执行控制动作（统一入口）
   *
   * 根据 ControlTaskInput 的 action 字段，调用相应的控制方法
   * 这是为 MCP 工具接口提供的统一入口
   *
   * @param input 控制任务输入
   * @returns 操作结果
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   *
   * // 暂停
   * await controller.execute({
   *   action: 'pause',
   *   documentId: 'doc-123'
   * });
   *
   * // 重试
   * await controller.execute({
   *   action: 'retry',
   *   documentId: 'doc-123',
   *   taskId: 'task-456'
   * });
   * ```
   */
  async execute(input: ControlTaskInput): Promise<ControlTaskOutput> {
    // 参数验证
    if (!input || typeof input !== 'object') {
      return {
        ok: false,
        message: tEngine('invalid_input'),
      };
    }

    const { action, documentId, taskId } = input;

    // 验证必需字段
    if (!action) {
      return {
        ok: false,
        message: tEngine('action_required'),
      };
    }

    if (!documentId) {
      return {
        ok: false,
        message: tEngine('document_id_required'),
      };
    }

    // 根据 action 调用相应的方法
    try {
      switch (action) {
        case 'pause':
          return await this.pause(documentId);

        case 'resume':
          return await this.resume(documentId);

        case 'retry':
          if (!taskId) {
            return {
              ok: false,
              message: tEngine('retry_requires_task_id'),
            };
          }
          return await this.retry(documentId, taskId);

        case 'cancel':
          return await this.cancel(documentId);

        default:
          return {
            ok: false,
            message: tEngine('unknown_action', { action }),
          };
      }
    } catch (error: unknown) {
      // 统一错误处理
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

      console.error(`[TaskController] 执行操作失败 (action: ${action}, documentId: ${documentId}):`, error);

      return {
        ok: false,
        message: tEngine('action_failed', { error: errorMessage }),
      };
    }
  }

  /**
   * 批量重试失败的任务
   *
   * 获取所有失败的任务，并逐个重试
   * 这是一个便利方法，简化多任务重试流程
   *
   * @param documentId 文档 ID
   * @returns 操作结果，包含重试的任务数
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const result = await controller.retryAllFailed('doc-123');
   * console.log(`重试了 ${result.retriedCount} 个失败任务`);
   * ```
   */
  async retryAllFailed(documentId: string): Promise<{
    ok: boolean;
    message: string;
    retriedCount: number;
    failedRetries: string[];
  }> {
    try {
      // 获取所有任务
      const tasks = await this.getTaskStatus(documentId);

      // 筛选失败口径任务（Failed / Truncated / Cancelled，与会话统计
      // failed_tasks 一致；仅含 Cancelled 的会话点重试也应生效）
      const failedTasks = tasks.filter(task => isFailedLikeTaskStatus(task.status));

      if (failedTasks.length === 0) {
        return {
          ok: true,
          message: tEngine('retry_all_none'),
          retriedCount: 0,
          failedRetries: [],
        };
      }

      // 逐个重试
      let retriedCount = 0;
      const failedRetries: string[] = [];

      for (const task of failedTasks) {
        const result = await this.retry(documentId, task.taskId);
        if (result.ok) {
          retriedCount++;
        } else {
          failedRetries.push(task.taskId);
        }
      }

      const allSuccess = failedRetries.length === 0;

      return {
        ok: allSuccess,
        message: allSuccess
          ? tEngine('retry_all_success', { count: retriedCount })
          : tEngine('retry_all_partial', { succeeded: retriedCount, failed: failedRetries.length }),
        retriedCount,
        failedRetries,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

      console.error(`[TaskController] 批量重试失败 (documentId: ${documentId}):`, error);

      return {
        ok: false,
        message: tEngine('retry_all_failed', { error: errorMessage }),
        retriedCount: 0,
        failedRetries: [],
      };
    }
  }

  /**
   * 检查文档是否可以恢复
   *
   * 判断文档是否处于暂停状态，可以安全恢复
   *
   * @param documentId 文档 ID
   * @returns 是否可以恢复
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * if (await controller.canResume('doc-123')) {
   *   await controller.resume('doc-123');
   * }
   * ```
   */
  async canResume(documentId: string): Promise<boolean> {
    try {
      const state = await this.getDocumentState(documentId);
      return state.status === 'paused';
    } catch (error: unknown) {
      console.error(`[TaskController] 检查恢复状态失败 (documentId: ${documentId}):`, error);
      return false;
    }
  }

  /**
   * 检查文档是否正在处理
   *
   * 判断文档是否有任务正在处理中
   *
   * @param documentId 文档 ID
   * @returns 是否正在处理
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * if (await controller.isProcessing('doc-123')) {
   *   console.log('文档正在处理中，请稍候');
   * }
   * ```
   */
  async isProcessing(documentId: string): Promise<boolean> {
    try {
      const state = await this.getDocumentState(documentId);
      return state.status === 'processing';
    } catch (error: unknown) {
      console.error(`[TaskController] 检查处理状态失败 (documentId: ${documentId}):`, error);
      return false;
    }
  }

  /**
   * 获取处理进度
   *
   * 计算文档的处理进度百分比
   *
   * @param documentId 文档 ID
   * @returns 进度百分比 (0-100)
   *
   * @example
   * ```typescript
   * const controller = new TaskController();
   * const progress = await controller.getProgress('doc-123');
   * console.log(`进度: ${progress.toFixed(1)}%`);
   * ```
   */
  async getProgress(documentId: string): Promise<number> {
    try {
      const state = await this.getDocumentState(documentId);

      if (state.total_tasks === 0) {
        return 0;
      }

      return (state.completed_tasks / state.total_tasks) * 100;
    } catch (error: unknown) {
      console.error(`[TaskController] 获取进度失败 (documentId: ${documentId}):`, error);
      return 0;
    }
  }
}

/**
 * 创建 TaskController 实例的工厂函数
 *
 * @returns TaskController 实例
 *
 * @example
 * ```typescript
 * import { createTaskController } from './TaskController';
 *
 * const controller = createTaskController();
 * await controller.pause('doc-123');
 * ```
 */
export function createTaskController(): TaskController {
  return new TaskController();
}

/**
 * 默认导出的单例实例
 *
 * 大多数情况下，使用这个单例实例即可
 *
 * @example
 * ```typescript
 * import taskController from './TaskController';
 *
 * await taskController.pause('doc-123');
 * ```
 */
export default new TaskController();
