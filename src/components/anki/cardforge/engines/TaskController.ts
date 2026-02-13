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
 * | 取消 | delete_document_session | 清理文档会话 |
 * | 查询状态 | get_document_tasks | 获取所有任务状态 |
 *
 * @module TaskController
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  ControlTaskInput,
  ControlTaskOutput,
  TaskInfo,
  TaskStatus,
} from '../types';

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
    try {
      // 参数验证
      if (!documentId || documentId.trim() === '') {
        return {
          ok: false,
          message: '文档 ID 不能为空',
        };
      }

      // 调用后端暂停命令
      await invoke<void>('pause_document_processing', {
        documentId: documentId.trim(),
      });

      // 获取更新后的任务状态
      const tasks = await this.getTaskStatus(documentId);

      return {
        ok: true,
        message: '文档处理已暂停',
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
        message: `暂停失败: ${errorMessage}`,
      };
    }
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
    try {
      // 参数验证
      if (!documentId || documentId.trim() === '') {
        return {
          ok: false,
          message: '文档 ID 不能为空',
        };
      }

      // 调用后端恢复命令
      await invoke<void>('resume_document_processing', {
        documentId: documentId.trim(),
      });

      // 获取更新后的任务状态
      const tasks = await this.getTaskStatus(documentId);

      return {
        ok: true,
        message: '文档处理已恢复',
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
        message: `恢复失败: ${errorMessage}`,
      };
    }
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
    try {
      // 参数验证
      if (!documentId || documentId.trim() === '') {
        return {
          ok: false,
          message: '文档 ID 不能为空',
        };
      }

      if (!taskId || taskId.trim() === '') {
        return {
          ok: false,
          message: '任务 ID 不能为空',
        };
      }

      // 调用后端重试命令
      await invoke<void>('trigger_task_processing', {
        task_id: taskId.trim(),
      });

      // 获取更新后的任务状态
      const tasks = await this.getTaskStatus(documentId);

      return {
        ok: true,
        message: `任务 ${taskId} 已重新提交`,
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
        message: `重试失败: ${errorMessage}`,
      };
    }
  }

  /**
   * 取消文档处理
   *
   * 调用后端 delete_document_session 命令，清理文档会话
   * 会停止所有未完成的任务，并删除相关状态
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
    try {
      // 参数验证
      if (!documentId || documentId.trim() === '') {
        return {
          ok: false,
          message: '文档 ID 不能为空',
        };
      }

      // 调用后端删除会话命令
      // 后端会清理 DOCUMENT_STATES 和 RUNNING_HANDLES
      // 注意：统一使用 snake_case 参数名与后端 Rust 命令保持一致
      await invoke<void>('delete_document_session', {
        documentId: documentId.trim(),
      });

      return {
        ok: true,
        message: '文档处理已取消，会话已清理',
        tasks: [], // 取消后任务列表为空
      };
    } catch (error: unknown) {
      // 错误处理
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

      console.error(`[TaskController] 取消文档失败 (documentId: ${documentId}):`, error);

      return {
        ok: false,
        message: `取消失败: ${errorMessage}`,
      };
    }
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
    if (typeof status !== 'string') {
      return 'pending';
    }
    const trimmed = status.trim();
    const statusMap: Record<string, TaskStatus> = {
      Pending: 'pending',
      Processing: 'processing',
      Streaming: 'streaming',
      Paused: 'paused',
      Completed: 'completed',
      Failed: 'failed',
      Truncated: 'truncated',
      Cancelled: 'cancelled',
      pending: 'pending',
      processing: 'processing',
      streaming: 'streaming',
      paused: 'paused',
      completed: 'completed',
      failed: 'failed',
      truncated: 'truncated',
      cancelled: 'cancelled',
    };

    return statusMap[trimmed] ?? statusMap[trimmed.toLowerCase()] ?? 'pending';
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

      try {
        // 优先使用最新命令名
        return await invoke<DocumentState>('get_document_processing_state', {
          documentId: trimmedId,
        });
      } catch (error: unknown) {
        // 兼容旧命令名
        return await invoke<DocumentState>('get_document_state', {
          documentId: trimmedId,
        });
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
        message: '无效的输入参数',
      };
    }

    const { action, documentId, taskId } = input;

    // 验证必需字段
    if (!action) {
      return {
        ok: false,
        message: '缺少 action 参数',
      };
    }

    if (!documentId) {
      return {
        ok: false,
        message: '缺少 documentId 参数',
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
              message: 'retry 操作需要提供 taskId 参数',
            };
          }
          return await this.retry(documentId, taskId);

        case 'cancel':
          return await this.cancel(documentId);

        default:
          return {
            ok: false,
            message: `未知的操作类型: ${action}`,
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
        message: `操作失败: ${errorMessage}`,
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

      // 筛选失败的任务
      const failedTasks = tasks.filter(task =>
        task.status === 'failed' || task.status === 'truncated'
      );

      if (failedTasks.length === 0) {
        return {
          ok: true,
          message: '没有失败的任务需要重试',
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
          ? `成功重试 ${retriedCount} 个失败任务`
          : `重试了 ${retriedCount} 个任务，${failedRetries.length} 个失败`,
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
        message: `批量重试失败: ${errorMessage}`,
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
