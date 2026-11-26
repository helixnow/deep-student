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

import { isAndroid } from '@/utils/platform';
import React, { useCallback, useEffect, useRef } from 'react';
import type { SlashApplyTrigger, UseSkillSlashCommandsReturn } from './SkillSlashPopover';
import { shouldHandleSkillSlashKey } from './SkillSlashPopover';
import { shouldHandleModelMentionKey } from './useModelMentionAutocomplete';
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
  applySkillSlashSelection: (index?: number, trigger?: SlashApplyTrigger) => boolean;
  modelMentionState?: ModelMentionState;
  modelMentionActions?: ModelMentionActions;
}

/**
 * compositionend 之后的 Enter 抑制窗口（毫秒）：
 * 覆盖 Safari/WebKit、Linux IBus/Fcitx 及 CDP/Playwright 场景下，
 * 确认候选词的 Enter keydown 在 compositionend 之后的下一帧/宏任务到达且 isComposing=false 的时序。
 */
const IME_COMPOSITION_END_GRACE_MS = 150;

function getMonotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
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
  // 🔧 跨端 IME 时序修复：Safari/WebKit、Linux IBus/Fcitx、Playwright/CDP 中
  // compositionend 可能先于确认候选词的 Enter keydown 触发，且该 keydown 的 isComposing 已为 false。
  // 记录 compositionend 时间戳，在短窗口内拦截紧随其后的确认 Enter（遇非 Enter 按键或新文本改动立即解除）。
  const compositionJustEndedRef = useRef(false);
  const compositionEndedAtRef = useRef<number | null>(null);
  const lastComposedValueRef = useRef<string | null>(null);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCompositionEndGrace = useCallback(() => {
    compositionJustEndedRef.current = false;
    compositionEndedAtRef.current = null;
    lastComposedValueRef.current = null;
    if (compositionEndTimerRef.current !== null) {
      clearTimeout(compositionEndTimerRef.current);
      compositionEndTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearCompositionEndGrace, [clearCompositionEndGrace]);

  // 实时 IME 合成态检测：标准 isComposing / key==='Process' / keyCode 229 / 合成期间 ref
  const isLiveImeComposing = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { keyCode?: number; which?: number };
    const eventWithLegacyFields = e as React.KeyboardEvent<HTMLTextAreaElement> & {
      isComposing?: boolean;
      keyCode?: number;
      which?: number;
    };
    const keyCode = nativeEvent?.keyCode ?? eventWithLegacyFields.keyCode;
    const which = eventWithLegacyFields.which ?? nativeEvent?.which;
    return Boolean(
      eventWithLegacyFields.isComposing ||
      nativeEvent?.isComposing ||
      e.key === 'Process' ||
      nativeEvent?.key === 'Process' ||
      which === 229 ||
      keyCode === 229 ||
      isComposingRef.current
    );
  }, []);

  const isInCompositionEndGrace = useCallback(() => {
    if (compositionEndedAtRef.current !== null) {
      const elapsed = getMonotonicNowMs() - compositionEndedAtRef.current;
      if (elapsed >= 0 && elapsed < IME_COMPOSITION_END_GRACE_MS) {
        return true;
      }
      clearCompositionEndGrace();
      return false;
    }
    return compositionJustEndedRef.current;
  }, [clearCompositionEndGrace]);

  // IME 合成态检测（含实时合成态与 compositionend 后短时间窗）
  const isImeComposing = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) =>
      isLiveImeComposing(e) || isInCompositionEndGrace(),
    [isLiveImeComposing, isInCompositionEndGrace]
  );

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
            clearCompositionEndGrace();
          }}
          onCompositionUpdate={() => {
            isComposingRef.current = true;
            clearCompositionEndGrace();
          }}
          onCompositionEnd={(e) => {
            isComposingRef.current = false;
            const composedTarget = e.target as HTMLTextAreaElement;
            // Safari/WebKit/Linux IME/CDP：确认 Enter 的 keydown 可能晚于 compositionend 到达，
            // 用 150ms 窗口拦截该确认 Enter，避免误触发送或插入多余换行
            compositionJustEndedRef.current = true;
            compositionEndedAtRef.current = getMonotonicNowMs();
            lastComposedValueRef.current = composedTarget.value;
            if (compositionEndTimerRef.current !== null) {
              clearTimeout(compositionEndTimerRef.current);
            }
            compositionEndTimerRef.current = setTimeout(() => {
              clearCompositionEndGrace();
            }, IME_COMPOSITION_END_GRACE_MS);
            // 合成结束时用最终值同步 store，确保不丢字
            onInputChange(composedTarget.value);
            onCaretPosChange(composedTarget.selectionStart);
            setTimeout(() => {
              adjustTextareaHeight();
              scrollCaretIntoView();
            }, 0);
          }}
          onChange={(e) => {
            // compositionend 之后若用户产生了新的文本变更（与刚提交的候选词不同），立即解除宽限期
            if (
              !isComposingRef.current &&
              compositionEndedAtRef.current !== null &&
              e.target.value !== lastComposedValueRef.current
            ) {
              clearCompositionEndGrace();
            }
            // Gboard updates the composing word on each key. Keep the controlled value in sync.
            if (!isComposingRef.current || !isMobile || isAndroid()) {
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
            const liveComposing = isLiveImeComposing(e);
            if (liveComposing) {
              return;
            }

            if (isInCompositionEndGrace()) {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!e.repeat) {
                  clearCompositionEndGrace();
                }
                return;
              }
              if (e.key !== 'Unidentified') {
                clearCompositionEndGrace();
              }
            }

            // ★ Linux/GTK WebView: Ctrl/Cmd+A must select composer text and MUST NOT
            // open the OS file picker (hidden <input type="file"> / native accelerator).
            if (
              !isImeComposing(e) &&
              (e.ctrlKey || e.metaKey) &&
              !e.altKey &&
              !e.shiftKey &&
              e.key.toLowerCase() === 'a'
            ) {
              e.preventDefault();
              e.stopPropagation();
              const textarea = e.currentTarget;
              textarea.select();
              onCaretPosChange(textarea.selectionStart);
              return;
            }

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
                const trigger: SlashApplyTrigger = e.key === 'Tab' ? 'tab' : 'enter';
                if (applySkillSlashSelection(undefined, trigger)) {
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
