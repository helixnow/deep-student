/**
 * Chat V2 - TodoList 任务列表块渲染插件
 *
 * 显示 Agent 任务进度和步骤状态
 * TODO list 展示风格：
 * - 可折叠面板
 * - 进度摘要 "X / Y tasks done"
 * - 每个任务有状态图标（✓完成、●执行中、○待处理）
 *
 * 自执行注册：import 即注册
 */

import React, { useState, useCallback, useMemo } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Circle, Loader2, X, SkipForward, ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';

// ============================================================================
// 类型定义
// ============================================================================

/** 任务步骤状态 */
export type TodoStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** 单个任务步骤 */
export interface TodoStep {
  id: string;
  description: string;
  status: TodoStatus;
  result?: string;
  createdAt: number;
  updatedAt?: number;
}

/** TodoList 块输出数据 */
export interface TodoListOutput {
  success: boolean;
  todoListId?: string;
  title?: string;
  steps?: TodoStep[];
  progress?: string;
  completedCount?: number;
  totalCount?: number;
  isAllDone?: boolean;
  nextStep?: TodoStep;
  currentRunning?: TodoStep;
  message?: string;
  continue_execution?: boolean;
}

// ============================================================================
// 状态图标组件
// ============================================================================

interface StatusIconProps {
  status: TodoStatus;
  index: number;
}

/**
 * 状态图标（缩小版）
 * - pending: 灰色空心圆圈
 * - running: 蓝色实心圆圈 + 序号
 * - completed: 绿色勾选
 * - failed: 红色叉号
 * - skipped: 灰色圆圈
 */
const StatusIcon: React.FC<StatusIconProps> = ({ status, index }) => {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-500 text-white text-[9px] font-bold flex-shrink-0">
          {index + 1}
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500/20 flex-shrink-0">
          <Check className="w-3 h-3 text-green-500" strokeWidth={3} />
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500/20 flex-shrink-0">
          <X className="w-3 h-3 text-red-500" strokeWidth={3} />
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-muted flex-shrink-0">
          <SkipForward className="w-2.5 h-2.5 text-muted-foreground" />
        </span>
      );
    default: // pending
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-muted-foreground/30 flex-shrink-0">
          <Circle className="w-1.5 h-1.5 text-muted-foreground/30" fill="currentColor" />
        </span>
      );
  }
};

// ============================================================================
// TodoListPanel 组件
// ============================================================================

export interface TodoListPanelProps {
  /** 任务标题 */
  title?: string;
  /** 步骤列表 */
  steps: TodoStep[];
  /** 是否所有任务已完成 */
  isAllDone?: boolean;
  /** 完成数量 */
  completedCount?: number;
  /** 总数量 */
  totalCount?: number;
  /** 附加消息 */
  message?: string;
  /** 自定义类名 */
  className?: string;
  /** 默认是否展开 */
  defaultExpanded?: boolean;
  /** 🆕 本次变更的步骤 ID（用于 diff 显示） */
  changedStepId?: string;
  /** 🆕 工具名称（todo_init/todo_update/todo_add/todo_get） */
  toolName?: string;
}

/**
 * TodoListPanel - 任务列表面板
 *
 * 特点：
 * 1. 可折叠的头部，显示进度摘要
 * 2. 紧凑的任务列表
 * 3. 清晰的状态图标
 */
export const TodoListPanel: React.FC<TodoListPanelProps> = ({
  title,
  steps,
  isAllDone,
  completedCount: propCompletedCount,
  totalCount: propTotalCount,
  message,
  className,
  defaultExpanded = false, // 🔧 P7: 默认折叠
  changedStepId,
  toolName,
}) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // 计算完成数量
  const completedCount = propCompletedCount ?? steps.filter(
    s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
  ).length;
  const totalCount = propTotalCount ?? steps.length;
  const doneCount = steps.filter(s => s.status === 'completed').length;

  // 🆕 找到本次变更的步骤
  const changedStep = changedStepId ? steps.find(s => s.id === changedStepId) : undefined;
  
  // 🆕 判断是否为初始化工具（显示全部）还是更新工具（显示 diff）
  const isInitTool = toolName === 'todo_init' || toolName === 'builtin-todo_init';
  const isGetTool = toolName === 'todo_get' || toolName === 'builtin-todo_get';

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  if (steps.length === 0) {
    return null;
  }

  // 🆕 生成折叠模式的摘要文本
  const getCollapsedSummary = () => {
    if (isInitTool || isGetTool) {
      // 初始化或获取：显示进度
      return `${doneCount} / ${totalCount} ${t('timeline.todoList.tasksDone', 'tasks done')}`;
    }
    if (changedStep) {
      // 更新：显示变更的步骤
      const statusText = changedStep.status === 'completed' ? '✓' 
        : changedStep.status === 'running' ? '●' 
        : changedStep.status === 'failed' ? '✗'
        : '○';
      return `${statusText} ${changedStep.description}`;
    }
    return `${doneCount} / ${totalCount} ${t('timeline.todoList.tasksDone', 'tasks done')}`;
  };

  return (
    <div className={cn('todo-list-panel', className)}>
      {/* 可折叠头部 - 显示摘要或 diff */}
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={toggleExpanded}
        className="w-full !justify-start gap-1.5 !py-0.5 text-left text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 transition-transform duration-200 flex-shrink-0',
            !isExpanded && '-rotate-90'
          )}
        />
        <span className={cn(
          'truncate',
          !isExpanded && changedStep?.status === 'completed' && 'text-green-600 dark:text-green-400',
          !isExpanded && changedStep?.status === 'running' && 'text-blue-600 dark:text-blue-400',
          !isExpanded && changedStep?.status === 'failed' && 'text-red-600 dark:text-red-400'
        )}>
          {getCollapsedSummary()}
        </span>
      </NotionButton>

      {/* 任务列表 - 可折叠 */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className={cn(
              'mt-1.5 rounded-md overflow-hidden',
              'bg-muted/30 dark:bg-muted/20',
              'border border-border/50'
            )}>
              <ul className="py-0.5">
                {steps.map((step, index) => (
                  <li
                    key={step.id || index}
                    className={cn(
                      'flex items-start gap-2 px-2 py-1',
                      'text-xs',
                      step.status === 'completed' && 'text-green-600 dark:text-green-400',
                      step.status === 'running' && 'text-foreground font-medium',
                      step.status === 'failed' && 'text-red-600 dark:text-red-400',
                      step.status === 'skipped' && 'text-muted-foreground line-through',
                      step.status === 'pending' && 'text-muted-foreground',
                      // 🆕 高亮本次变更的步骤
                      step.id === changedStepId && 'bg-primary/10 -mx-2 px-2 rounded'
                    )}
                  >
                    <StatusIcon status={step.status} index={index} />
                    <div className="flex-1 min-w-0">
                      <span className={cn(
                        'block leading-4',
                        step.status === 'completed' && 'line-through opacity-80'
                      )}>
                        {step.description}
                      </span>
                      {/* 失败时显示错误信息 */}
                      {step.status === 'failed' && step.result && (
                        <span className="block text-[10px] text-red-500/80 mt-0.5">
                          {step.result}
                        </span>
                      )}
                    </div>
                    {/* 执行中的加载动画 */}
                    {step.status === 'running' && (
                      <Loader2 className="w-3 h-3 animate-spin text-blue-500 flex-shrink-0 mt-0.5" />
                    )}
                  </li>
                ))}
              </ul>
            </div>

            {/* 完成消息 */}
            {isAllDone && message && (
              <div className="mt-1 text-[10px] text-green-600 dark:text-green-400">
                {message}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ============================================================================
// TodoListBlock 组件（兼容旧的块渲染）
// ============================================================================

/**
 * TodoListBlock - 任务列表块渲染组件
 *
 * 用于在 BlockRenderer 中渲染单独的 todo_list 块
 * 实际上在 ActivityTimeline 中会被聚合渲染
 */
const TodoListBlock: React.FC<BlockComponentProps> = ({ block }) => {
  // 从 toolOutput 解析数据
  const output = block.toolOutput as TodoListOutput | undefined;
  
  if (!output) {
    return (
      <div className="text-sm text-muted-foreground">
        任务列表加载中...
      </div>
    );
  }

  const { title, steps = [], isAllDone, completedCount, totalCount, message } = output;

  return (
    <TodoListPanel
      title={title}
      steps={steps}
      isAllDone={isAllDone}
      completedCount={completedCount}
      totalCount={totalCount}
      message={message}
      defaultExpanded={true}
    />
  );
};

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('todo_list', {
  type: 'todo_list',
  component: TodoListBlock,
  onAbort: 'keep-content',
});

export { TodoListBlock };
