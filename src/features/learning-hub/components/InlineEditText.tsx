import React, { useRef, useEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';

export interface InlineEditTextProps {
  /** 当前值 */
  value: string;
  /** 是否处于编辑状态 */
  isEditing: boolean;
  /** 确认编辑回调 */
  onConfirm: (newValue: string) => void;
  /** 取消编辑回调 */
  onCancel: () => void;
  /** 只选中文件名部分，不选中扩展名 */
  selectNameOnly?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 输入框类名 */
  inputClassName?: string;
  /** 文本显示类名 */
  textClassName?: string;
  /** 最大字符数 */
  maxLength?: number;
  /** 是否禁用编辑 */
  disabled?: boolean;
  /** 输入框宽度随内容收缩（Finder 图标视图重命名） */
  autoSize?: boolean;
}

const FULL_WIDTH_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6]/;

function getTextWidthEm(value: string): number {
  return Math.max(
    1,
    Array.from(value).reduce((width, character) => (
      width + (FULL_WIDTH_CHAR.test(character) ? 1 : 0.58)
    ), 0),
  );
}

/**
 * 内联编辑文本组件
 * 模拟 macOS Finder 的文件重命名交互：
 * - 编辑时文本框出现
 * - 文件名部分被选中（如有扩展名则不选中扩展名）
 * - Enter 确认 / Escape 取消 / 点击外部确认
 * 
 * 使用 React.memo 优化，避免列表项重渲染时不必要的子组件更新
 */
export const InlineEditText = React.memo(function InlineEditText({
  value,
  isEditing,
  onConfirm,
  onCancel,
  selectNameOnly = true,
  className,
  inputClassName,
  textClassName,
  maxLength = 255,
  disabled = false,
  autoSize = false,
}: InlineEditTextProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(value);
  const isComposingRef = useRef(false);
  // 追踪是否已经处理过确认/取消，避免 onBlur 重复触发
  const hasHandledRef = useRef(false);

  // 同步外部值变化（编辑中不覆盖用户正在输入的内容）
  useEffect(() => {
    if (!isEditing) {
      setEditValue(value);
    }
  }, [value, isEditing]);

  // 进入编辑时重置 hasHandled 标记，并以当时的最新值作为编辑起点
  // （deps 有意不含 value：编辑期间外部值变化不应重置输入）
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (isEditing) {
      hasHandledRef.current = false;
      setEditValue(valueRef.current);
    }
  }, [isEditing]);

  // 编辑开始时自动聚焦并选中文本
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      
      // 选中文本：如果 selectNameOnly 且有扩展名，只选中文件名部分
      const currentValue = inputRef.current.value;
      const lastDotIndex = currentValue.lastIndexOf('.');
      
      if (selectNameOnly && lastDotIndex > 0) {
        // 选中从开头到最后一个点之前的内容
        inputRef.current.setSelectionRange(0, lastDotIndex);
      } else {
        // 选中全部
        inputRef.current.select();
      }
    }
  }, [isEditing, selectNameOnly]);

  // 处理确认
  const handleConfirm = useCallback(() => {
    // 防止重复处理
    if (hasHandledRef.current) return;
    hasHandledRef.current = true;
    
    const trimmedValue = editValue.trim();
    if (trimmedValue && trimmedValue !== value) {
      onConfirm(trimmedValue);
    } else {
      // 值未变化或为空，视为取消
      onCancel();
    }
  }, [editValue, value, onConfirm, onCancel]);

  // 处理取消
  const handleCancel = useCallback(() => {
    // 防止重复处理
    if (hasHandledRef.current) return;
    hasHandledRef.current = true;
    
    setEditValue(value); // 恢复原值
    onCancel();
  }, [value, onCancel]);

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法正在输入时不处理
    if (isComposingRef.current) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
    }
  }, [handleConfirm, handleCancel]);

  // 失焦时确认（模拟点击外部确认）
  const handleBlur = useCallback(() => {
    // 使用 requestAnimationFrame 而不是 setTimeout，更可靠
    requestAnimationFrame(() => {
      handleConfirm();
    });
  }, [handleConfirm]);

  // 输入变化
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  // 阻止事件冒泡
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // 处理 IME 输入
  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  if (!isEditing) {
    return (
      <span className={cn("truncate", textClassName, className)}>
        {value}
      </span>
    );
  }

  return (
    <Input
      ref={inputRef}
      type="text"
      value={editValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={handleClick}
      onDoubleClick={handleClick}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      maxLength={maxLength}
      disabled={disabled}
      style={autoSize ? {
        width: `min(calc(${getTextWidthEm(editValue)}em + 10px), 100%)`,
      } : undefined}
      className={cn(
        // 基础样式 - 继承父元素字体
        autoSize ? "min-w-6 max-w-full px-1 py-0.5 text-[inherit] leading-[inherit]" : "w-full px-1 py-0.5 text-[inherit] leading-[inherit]",
        // 边框和背景 - macOS 风格
        "bg-background border border-primary/50 rounded",
        // 选中高亮
        "selection:bg-primary/30",
        // 聚焦样式
        "focus:outline-none focus:ring-1 focus:ring-primary/50",
        // 暗色模式支持
        "dark:bg-background dark:border-primary/40",
        inputClassName,
        className
      )}
    />
  );
});

export default InlineEditText;
