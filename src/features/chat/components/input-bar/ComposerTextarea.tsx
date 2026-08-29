/**
 * Composer 输入框 + IME 合成态处理（从 InputBarUI.tsx 拆出）
 *
 * 负责 textarea / ghost 测量元素的渲染，以及全部键盘输入路径：
 * - IME 合成态检测（标准 isComposing / keyCode 229 / Safari compositionend 时序）
 * - 技能斜杠命令与 @模型提及的 keydown 路由
 * - Enter 发送 / Shift+Enter 换行 / 队列语义
 *
 * DOM refs（textarea / ghost / 滚动 viewport）由父级持有：
 * 高度测量（adjustTextareaHeight）、光标滚动（scrollCaretIntoView）、
 * 语音插入与聚焦控制等父级逻辑都依赖这些 refs。
 */

import React, { useCallback, useEffect, useRef } from 'react';
import type { UseSkillSlashCommandsReturn } from './SkillSlashPopover';
import { shouldHandleSkillSlashKey } from './SkillSlashPopover';
import { shouldHandleModelMentionKey } from './ModelMentionPopover';
import type { ModelMentionState, ModelMentionActions } from './types';
import { INPUT_BAR_CONFIG } from './inputBarConfig';
import { cn } from '@/lib/utils';

export interface ComposerTextareaProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;

  inputValue: string;
  /** 已解析的占位符（父级完成 i18n 回退） */
  placeholder: string;
  isMobile: boolean;
  isStreaming: boolean;
  queueEnabled: boolean;
  /** 流式中 Enter 的语义开关：true 且非队列模式时 Enter 触发停止 */
  showStop: boolean;
  sendShortcut: 'enter' | 'mod-enter';
  textareaViewportHeight: number;

  onInputChange: (value: string) => void;
  /** 光标位置变化（父级用于斜杠命令 / @mention 检测） */
  onCaretPosChange: (pos: number) => void;
  adjustTextareaHeight: () => void;
  scrollCaretIntoView: () => void;
  onSend: () => void;
  onStop: () => void;
  /** textarea 聚焦状态（父级用于快捷键提示展示） */
  onFocusChange: (focused: boolean) => void;
  /** 粘贴处理（含附件转换与未就绪缓存，逻辑在父级） */
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;

  skillSlash: UseSkillSlashCommandsReturn;
  /** 补全应用：返回是否成功应用（父级同步输入值与光标） */
  applySkillSlashSelection: (index?: number) => boolean;
  modelMentionState?: ModelMentionState;
  modelMentionActions?: ModelMentionActions;
}

export const ComposerTextarea: React.FC<ComposerTextareaProps> = ({
  textareaRef,
  ghostRef,
  viewportRef,
  inputValue,
  placeholder,
  isMobile,
  isStreaming,
  queueEnabled,
  showStop,
  sendShortcut,
  textareaViewportHeight,
  onInputChange,
  onCaretPosChange,
  adjustTextareaHeight,
  scrollCaretIntoView,
  onSend,
  onStop,
  onFocusChange,
  onPaste,
  skillSlash,
  applySkillSlashSelection,
  modelMentionState,
  modelMentionActions,
}) => {
  // 🔧 IME 合成态追踪：防止 WKWebView 中文输入法重复追加文本
  const isComposingRef = useRef(false);
  // 🔧 Safari/WebKit 时序修复：compositionend 先于确认 Enter 的 keydown 触发，
  // 该 keydown 的 isComposing 已为 false，会把「确认候选词」误判为「发送」。
  // 标记 compositionend 后的同一轮事件循环，期间的 Enter 一律视为 IME 确认键。
  const compositionJustEndedRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (compositionEndTimerRef.current !== null) {
        clearTimeout(compositionEndTimerRef.current);
      }
    };
  }, []);

  // IME 合成态检测
  // 覆盖三类场景：1) 标准 isComposing；2) Windows/旧 WebView 的 keyCode 229；
  // 3) Safari/WebKit 在 compositionend 之后才派发确认 Enter 的 keydown（isComposing 已为 false）
  const isImeComposing = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const anyNative = e.nativeEvent as any;
    return Boolean(
      (e as any).isComposing ||
      (anyNative && anyNative.isComposing) ||
      (e as any).which === 229 ||
      (anyNative && anyNative.keyCode === 229) ||
      isComposingRef.current ||
      compositionJustEndedRef.current
    );
  }, []);

  // 判断是否应该发送
  const shouldSendOnEnter = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // C-11: 移动端软键盘没有 Shift+Enter，Enter 应为换行，发送只走按钮
      //（与微信/Telegram 移动端心智一致）
      if (isMobile) return false;
      const mode = sendShortcut || 'enter';
      if (mode === 'enter') {
        return e.key === 'Enter' && !e.shiftKey && !isImeComposing(e);
      }
      return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isImeComposing(e);
    },
    [isMobile, sendShortcut, isImeComposing]
  );

  return (
    <>
      <div
        ref={viewportRef}
        className={cn(
          'relative w-full',
          textareaViewportHeight >= INPUT_BAR_CONFIG.heights.textareaMax
            ? 'overflow-y-auto'
            : 'overflow-y-hidden',
        )}
        style={{ height: `${textareaViewportHeight}px` }}
      >
        <textarea
          data-testid="input-bar-v2-textarea"
          ref={textareaRef}
          aria-label={placeholder}
          value={inputValue}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            isComposingRef.current = false;
            // Safari/WebKit：确认 Enter 的 keydown 会在 compositionend 之后同步派发，
            // 用微小的时间窗标记它属于 IME 确认，避免误触发送
            compositionJustEndedRef.current = true;
            if (compositionEndTimerRef.current !== null) {
              clearTimeout(compositionEndTimerRef.current);
            }
            compositionEndTimerRef.current = setTimeout(() => {
              compositionJustEndedRef.current = false;
              compositionEndTimerRef.current = null;
            }, 0);
            // 合成结束时用最终值同步 store，确保不丢字
            const composedTarget = e.target as HTMLTextAreaElement;
            onInputChange(composedTarget.value);
            onCaretPosChange(composedTarget.selectionStart);
            setTimeout(() => {
              adjustTextareaHeight();
              scrollCaretIntoView();
            }, 0);
          }}
          onChange={(e) => {
            // 🔧 IME 合成期间跳过 store 更新，仅移动端 WKWebView 需要（桌面端受控组件会阻止输入）
            if (!isComposingRef.current || !isMobile) {
              onInputChange(e.target.value);
            }
            setTimeout(() => {
              adjustTextareaHeight();
              scrollCaretIntoView();
            }, 0);
            // 更新光标位置（用于斜杠命令 / 模型提及检测）
            onCaretPosChange(e.target.selectionStart);
            if (modelMentionActions) {
              modelMentionActions.updateCursorPosition(e.target.selectionStart);
            }
          }}
          placeholder={placeholder}
          onKeyDown={(e) => {
            // ★ 技能斜杠命令补全优先（与 @mention 的触发上下文互斥）
            if (
              !isImeComposing(e) &&
              shouldHandleSkillSlashKey(e, skillSlash.open)
            ) {
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                skillSlash.moveSelectionUp();
                return;
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                skillSlash.moveSelectionDown();
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                if (applySkillSlashSelection()) {
                  e.preventDefault();
                  return;
                }
                // 无可应用项：放行原按键语义（Enter 继续走发送）
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                skillSlash.dismiss();
                return;
              }
            }

            if (
              modelMentionState?.showAutoComplete &&
              modelMentionActions &&
              !isImeComposing(e) &&
              shouldHandleModelMentionKey(e, modelMentionState.showAutoComplete)
            ) {
              const hasMentionSuggestions = modelMentionState.suggestions.length > 0;
              if (e.key === 'ArrowUp' && hasMentionSuggestions) {
                e.preventDefault();
                modelMentionActions.moveSelectionUp();
                return;
              }
              if (e.key === 'ArrowDown' && hasMentionSuggestions) {
                e.preventDefault();
                modelMentionActions.moveSelectionDown();
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                const result = modelMentionActions.confirmSelection();
                if (result) {
                  e.preventDefault();
                  onInputChange(result.value);
                  onCaretPosChange(result.caret);
                  // 光标精确回到 mention 起点（不再粗暴移到末尾）
                  const textarea = textareaRef.current;
                  if (textarea) {
                    requestAnimationFrame(() => {
                      textarea.setSelectionRange(result.caret, result.caret);
                      modelMentionActions.updateCursorPosition(result.caret);
                    });
                  }
                  return;
                }
                // 无候选（noResults 提示态）：放行 Enter 走正常发送
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                modelMentionActions.closeAutoComplete();
                return;
              }
            }

            // 🔧 Chip 模式：输入为空时按 Backspace 删除最后一个 chip
            if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              const textarea = textareaRef.current;
              if (
                textarea &&
                textarea.selectionStart === 0 &&
                textarea.selectionEnd === 0 &&
                inputValue === '' &&
                modelMentionState?.selectedModels.length
              ) {
                e.preventDefault();
                modelMentionActions?.removeLastSelectedModel();
                return;
              }
            }

            // 正常的发送快捷键处理
            if (shouldSendOnEnter(e)) {
              e.preventDefault();
              // 队列/引导模式下，流式中的 Enter 语义改成“入队”，
              // Stop 只保留给按钮显式点击，避免键盘误中断当前回复。
              if (showStop && !queueEnabled) {
                onStop();
              } else {
                onSend();
              }
              return;
            }
          }}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onSelect={(e) => {
            // 光标位置变化时更新（支持点击、选择等操作）
            const selectionStart = (e.target as HTMLTextAreaElement).selectionStart;
            onCaretPosChange(selectionStart);
            if (modelMentionActions) {
              modelMentionActions.updateCursorPosition(selectionStart);
            }
            // ★ M4：键盘移动光标（方向键/Home/End）时也保证光标可见
            scrollCaretIntoView();
          }}
          onPaste={onPaste}
          readOnly={isStreaming && !queueEnabled}
          rows={1}
          className="w-full resize-none border-0 bg-transparent py-1 text-md leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-0 overflow-hidden [@media(pointer:coarse)]:text-[16px]"
          style={{
            minHeight: '40px',
            background: 'transparent',
          }}
        />
      </div>
      {/* Ghost element for height calculation */}
      <div
        ref={ghostRef}
        aria-hidden="true"
        className="invisible absolute top-0 left-0 -z-50 overflow-hidden whitespace-pre-wrap break-words text-md leading-relaxed [@media(pointer:coarse)]:text-[16px]"
        style={{
          minHeight: '40px',
          lineHeight: '24px',
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
      />
    </>
  );
};

export default ComposerTextarea;
