import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from './Input';
import { X } from '@phosphor-icons/react';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { splitTagDraft } from '@/utils/tagDraft';

export interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

function normalizeToken(token: string) {
  return token.trim().replace(/\s+/g, ' ');
}

const TagInput: React.FC<TagInputProps> = ({ value, onChange, placeholder, disabled }) => {
  const { t: translate } = useTranslation(['common']);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** 提交若干标签（大小写不敏感去重），草稿置为 rest */
  const addTokens = useCallback(
    (raws: string[], rest = '') => {
      const seen = new Set(value.map((t) => t.toLowerCase()));
      const added: string[] = [];
      for (const raw of raws) {
        const token = normalizeToken(raw);
        if (!token || seen.has(token.toLowerCase())) continue;
        seen.add(token.toLowerCase());
        added.push(token);
      }
      if (added.length) onChange([...value, ...added]);
      setDraft(rest);
    },
    [onChange, value]
  );

  // 📱 Android 软键盘的逗号 keydown 是 "Unidentified"/229，靠 keydown 永远提交不了；
  // 改从输入值切分（硬件键盘的 ',' keydown 已 preventDefault，不会重复提交）
  const applyDraft = useCallback(
    (next: string) => {
      const { tokens, rest } = splitTagDraft(next);
      if (tokens.length) addTokens(tokens, rest);
      else setDraft(next);
    },
    [addTokens]
  );

  const removeAt = useCallback(
    (idx: number) => {
      const next = value.slice();
      next.splice(idx, 1);
      onChange(next);
      inputRef.current?.focus();
    },
    [onChange, value]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (disabled) return;
      // IME 组字中的 Enter/Tab 属于输入法（确认候选词），不提交半成品
      if (isComposingKeyEvent(e)) return;
      if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
        if (draft.trim()) {
          e.preventDefault();
          addTokens([draft]);
        }
      } else if (e.key === 'Backspace' && !draft && value.length) {
        // 删除最后一个
        e.preventDefault();
        removeAt(value.length - 1);
      }
    },
    [addTokens, draft, removeAt, value, disabled]
  );

  const chips = useMemo(
    () =>
      value.map((t, i) => (
        <span
          key={`${t}-${i}`}
          className="inline-flex items-center gap-1 rounded-md border-transparent bg-muted/50 px-2 py-0.5 text-xs text-foreground"
        >
          {t}
          <button
            type="button"
            onClick={() => removeAt(i)}
            disabled={disabled}
            aria-label={`${translate('common:remove')} ${t}`}
            title={translate('common:remove')}
            // coarse 指针下用伪元素把 20px 命中区外扩至 44px（视觉仍是小叉）
            className="w-5 h-5 ml-1 relative inline-flex items-center justify-center rounded hover:bg-[var(--interactive-hover)] disabled:opacity-50 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3 [@media(pointer:coarse)]:after:content-['']"
          >
            <X size={12} className="text-muted-foreground" />
          </button>
        </span>
      )),
    [removeAt, value, disabled, translate]
  );

  return (
    <div className={`min-h-[40px] rounded-md border border-transparent bg-transparent hover:bg-[var(--interactive-hover)] focus-within:border-border/60 focus-within:bg-background focus-within:ring-1 focus-within:ring-border/50 transition-colors px-2 py-2 ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips}
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            // 组字期间不切分：改写受控值会打断输入法，留给 compositionend 处理
            if ((e.nativeEvent as InputEvent).isComposing) {
              setDraft(e.target.value);
              return;
            }
            applyDraft(e.target.value);
          }}
          onCompositionEnd={(e) => applyDraft(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          // coarse 下保证 ≥44px 触控高度（Input 基类的 lg:min-h 会收缩到 32px）
          className="border-none focus-visible:ring-0 px-0 py-0 h-6 [@media(pointer:coarse)]:!min-h-11 min-w-[8ch] flex-1"
        />
      </div>
    </div>
  );
};

export default TagInput;
