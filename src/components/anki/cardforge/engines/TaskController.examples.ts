/**
 * TaskController 使用示例
 *
 * 本文件演示如何使用 TaskController 进行任务控制
 */

import { TaskController, createTaskController, taskController } from './index';
import type { ControlTaskInput } from './index';

// ============================================================================
// 示例 1: 基本使用 - 使用单例实例
// ============================================================================

/**
 * 暂停文档处理
 */
async function example1_pauseDocument() {
  const documentId = 'doc-123';

  // 使用默认单例
  const result = await taskController.pause(documentId);

  if (result.ok) {
    console.log('✓ 暂停成功:', result.message);
    console.log('  任务数量:', result.tasks?.length ?? 0);
  } else {
    console.error('✗ 暂停失败:', result.message);
  }
}

/**
 * 恢复文档处理
 */
async function example2_resumeDocument() {
  const documentId = 'doc-123';

  // 检查是否可以恢复
  const canResume = await taskController.canResume(documentId);
  if (!canResume) {
    console.log('文档不在暂停状态，无需恢复');
    return;
  }

  const result = await taskController.resume(documentId);

  if (result.ok) {
    console.log('✓ 恢复成功:', result.message);
    if (result.tasks) {
      result.tasks.forEach(task => {
        console.log(`  任务 ${task.taskId}: ${task.status}`);
      });
    }
  } else {
    console.error('✗ 恢复失败:', result.message);
  }
}

/**
 * 重试失败的任务
 */
async function example3_retryFailedTask() {
  const documentId = 'doc-123';

  // 获取所有任务状态
  const tasks = await taskController.getTaskStatus(documentId);

  // 找到失败的任务
  const failedTask = tasks.find(task => task.status === 'failed');

  if (!failedTask) {
    console.log('没有失败的任务');
    return;
  }

  console.log(`重试失败任务: ${failedTask.taskId}`);
  const result = await taskController.retry(documentId, failedTask.taskId);

  if (result.ok) {
    console.log('✓ 重试成功:', result.message);
  } else {
    console.error('✗ 重试失败:', result.message);
  }
}

/**
 * 批量重试所有失败任务
 */
async function example4_retryAllFailed() {
  const documentId = 'doc-123';

  const result = await taskController.retryAllFailed(documentId);

  if (result.ok) {
    console.log('✓ 批量重试成功');
    console.log(`  已重试: ${result.retriedCount} 个任务`);
  } else {
    console.error('✗ 批量重试失败:', result.message);
    console.log(`  已重试: ${result.retriedCount} 个任务`);
    console.log(`  失败的任务:`, result.failedRetries);
  }
}

/**
 * 取消文档处理
 */
async function example5_cancelDocument() {
  const documentId = 'doc-123';

  // 确认是否真的要取消
  const confirmed = confirm('确定要取消文档处理吗？这将清理所有相关状态。');
  if (!confirmed) {
    return;
  }

  const result = await taskController.cancel(documentId);

  if (result.ok) {
    console.log('✓ 取消成功:', result.message);
  } else {
    console.error('✗ 取消失败:', result.message);
  }
}

// ============================================================================
// 示例 2: 使用工厂函数创建独立实例
// ============================================================================

/**
 * 创建独立的控制器实例
 */
async function example6_createInstance() {
  // 创建新实例（用于需要隔离的场景）
  const controller = createTaskController();

  const documentId = 'doc-456';

  // 查询文档状态
  const state = await controller.getDocumentState(documentId);
  console.log('文档状态:', state.status);
  console.log('进度:', `${state.completed_tasks}/${state.total_tasks}`);

  // 获取进度百分比
  const progress = await controller.getProgress(documentId);
  console.log('进度百分比:', `${progress.toFixed(1)}%`);
}

// ============================================================================
// 示例 3: 使用统一的 execute 方法（MCP 工具接口）
// ============================================================================

/**
 * 使用统一的 execute 方法
 */
async function example7_executeMethod() {
  const controller = new TaskController();

  // 暂停
  let input: ControlTaskInput = {
    action: 'pause',
    documentId: 'doc-789',
  };
  let result = await controller.execute(input);
  console.log('暂停结果:', result);

  // 恢复
  input = {
    action: 'resume',
    documentId: 'doc-789',
  };
  result = await controller.execute(input);
  console.log('恢复结果:', result);

  // 重试
  input = {
    action: 'retry',
    documentId: 'doc-789',
    taskId: 'task-001',
  };
  result = await controller.execute(input);
  console.log('重试结果:', result);

  // 取消
  input = {
    action: 'cancel',
    documentId: 'doc-789',
  };
  result = await controller.execute(input);
  console.log('取消结果:', result);
}

// ============================================================================
// 示例 4: 监控任务进度
// ============================================================================

/**
 * 轮询监控任务进度
 */
async function example8_monitorProgress() {
  const documentId = 'doc-123';
  const controller = taskController;

  console.log('开始监控任务进度...');

  const interval = setInterval(async () => {
    try {
      // 检查是否还在处理
      const isProcessing = await controller.isProcessing(documentId);
      if (!isProcessing) {
        console.log('✓ 处理完成');
        clearInterval(interval);
        return;
      }

      // 获取进度
      const progress = await controller.getProgress(documentId);
      const state = await controller.getDocumentState(documentId);

      console.log(
        `进度: ${progress.toFixed(1)}% | ` +
        `完成: ${state.completed_tasks}/${state.total_tasks} | ` +
        `失败: ${state.failed_tasks}`
      );

      // 如果有失败任务，可以选择自动重试
      if (state.failed_tasks > 0) {
        console.log('检测到失败任务，考虑重试...');
        // await controller.retryAllFailed(documentId);
      }
    } catch (error: unknown) {
      console.error('监控出错:', error);
      clearInterval(interval);
    }
  }, 2000); // 每 2 秒检查一次

  // 10 分钟后停止监控
  setTimeout(() => {
    clearInterval(interval);
    console.log('监控超时，已停止');
  }, 600000);
}

// ============================================================================
// 示例 5: 在 React 组件中使用
// ============================================================================

/**
 * React 组件示例
 */
/*
import React, { useState, useEffect } from 'react';
import { taskController } from './cardforge/engines';
import type { TaskInfo } from './cardforge/engines';

export function TaskControlPanel({ documentId }: { documentId: string }) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  // 加载任务状态
  useEffect(() => {
    const loadTasks = async () => {
      const taskList = await taskController.getTaskStatus(documentId);
      setTasks(taskList);

      const processing = await taskController.isProcessing(documentId);
      setIsProcessing(processing);

      const prog = await taskController.getProgress(documentId);
      setProgress(prog);
    };

    loadTasks();

    // 定时刷新
    const interval = setInterval(loadTasks, 3000);
    return () => clearInterval(interval);
  }, [documentId]);

  // 暂停
  const handlePause = async () => {
    const result = await taskController.pause(documentId);
    if (result.ok && result.tasks) {
      setTasks(result.tasks);
      setIsProcessing(false);
    }
  };

  // 恢复
  const handleResume = async () => {
    const result = await taskController.resume(documentId);
    if (result.ok && result.tasks) {
      setTasks(result.tasks);
      setIsProcessing(true);
    }
  };

  // 重试单个任务
  const handleRetry = async (taskId: string) => {
    const result = await taskController.retry(documentId, taskId);
    if (result.ok && result.tasks) {
      setTasks(result.tasks);
    }
  };

  // 重试所有失败任务
  const handleRetryAll = async () => {
    const result = await taskController.retryAllFailed(documentId);
    if (result.ok) {
      const taskList = await taskController.getTaskStatus(documentId);
      setTasks(taskList);
    }
  };

  // 取消
  const handleCancel = async () => {
    if (!confirm('确定要取消吗？')) return;

    const result = await taskController.cancel(documentId);
    if (result.ok) {
      setTasks([]);
      setIsProcessing(false);
      setProgress(0);
    }
  };

  return (
    <div className="task-control-panel">
      <div className="progress">
        <div className="progress-bar" style={{ width: `${progress}%` }}>
          {progress.toFixed(1)}%
        </div>
      </div>

      <div className="controls">
        {isProcessing ? (
          <button onClick={handlePause}>暂停</button>
        ) : (
          <button onClick={handleResume}>恢复</button>
        )}
        <button onClick={handleRetryAll}>重试失败</button>
        <button onClick={handleCancel}>取消</button>
      </div>

      <div className="task-list">
        {tasks.map(task => (
          <div key={task.taskId} className={`task task-${task.status}`}>
            <span>任务 {task.segmentIndex}</span>
            <span>{task.status}</span>
            <span>{task.cardsGenerated} 张卡片</span>
            {task.status === 'failed' && (
              <button onClick={() => handleRetry(task.taskId)}>重试</button>
            )}
            {task.errorMessage && (
              <div className="error">{task.errorMessage}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
*/

// ============================================================================
// 示例 6: 错误处理模式
// ============================================================================

/**
 * 完整的错误处理示例
 */
async function example9_errorHandling() {
  const controller = taskController;
  const documentId = 'doc-123';

  try {
    // 1. 验证文档 ID
    if (!documentId) {
      throw new Error('文档 ID 不能为空');
    }

    // 2. 检查文档状态
    const state = await controller.getDocumentState(documentId);
    console.log('当前状态:', state.status);

    // 3. 根据状态执行相应操作
    if (state.status === 'processing') {
      // 暂停处理中的文档
      const result = await controller.pause(documentId);
      if (!result.ok) {
        console.error('暂停失败:', result.message);
        return;
      }
    } else if (state.status === 'paused') {
      // 恢复暂停的文档
      const result = await controller.resume(documentId);
      if (!result.ok) {
        console.error('恢复失败:', result.message);
        return;
      }
    } else if (state.status === 'failed') {
      // 重试失败的文档
      const result = await controller.retryAllFailed(documentId);
      if (!result.ok) {
        console.error('重试失败:', result.message);
        console.log('失败的任务:', result.failedRetries);
      }
    }

    // 4. 获取最新状态
    const tasks = await controller.getTaskStatus(documentId);
    console.log('任务数量:', tasks.length);

    tasks.forEach(task => {
      console.log(
        `任务 ${task.segmentIndex}: ${task.status} ` +
        `(${task.cardsGenerated} 张卡片)`
      );
      if (task.errorMessage) {
        console.error(`  错误: ${task.errorMessage}`);
      }
    });
  } catch (error: unknown) {
    console.error('操作失败:', error);

    // 根据错误类型采取不同措施
    if (error instanceof Error) {
      if (error.message.includes('network')) {
        console.log('网络错误，请检查连接');
      } else if (error.message.includes('timeout')) {
        console.log('请求超时，稍后重试');
      } else {
        console.log('未知错误:', error.message);
      }
    }
  }
}

// ============================================================================
// 导出所有示例
// ============================================================================

export const examples = {
  pauseDocument: example1_pauseDocument,
  resumeDocument: example2_resumeDocument,
  retryFailedTask: example3_retryFailedTask,
  retryAllFailed: example4_retryAllFailed,
  cancelDocument: example5_cancelDocument,
  createInstance: example6_createInstance,
  executeMethod: example7_executeMethod,
  monitorProgress: example8_monitorProgress,
  errorHandling: example9_errorHandling,
};

/**
 * 运行所有示例（仅用于测试）
 */
export async function runAllExamples() {
  console.log('='.repeat(60));
  console.log('TaskController 使用示例');
  console.log('='.repeat(60));

  for (const [name, example] of Object.entries(examples)) {
    console.log(`\n--- ${name} ---`);
    try {
      await example();
    } catch (error: unknown) {
      console.error(`示例 ${name} 执行失败:`, error);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('所有示例执行完毕');
  console.log('='.repeat(60));
}

// 如果直接运行此文件
if (typeof window === 'undefined' && require.main === module) {
  runAllExamples().catch(console.error);
}
