import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from './Input';
import { X } from 'lucide-react';

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

  const addToken = useCallback(
    (raw: string) => {
      const token = normalizeToken(raw);
      if (!token) return;
      if (value.some((t) => t.toLowerCase() === token.toLowerCase())) {
        setDraft('');
        return;
      }
      onChange([...value, token]);
      setDraft('');
    },
    [onChange, value]
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
      if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
        if (draft.trim()) {
          e.preventDefault();
          addToken(draft);
        }
      } else if (e.key === 'Backspace' && !draft && value.length) {
        // 删除最后一个
        e.preventDefault();
        removeAt(value.length - 1);
      }
    },
    [addToken, draft, removeAt, value, disabled]
  );

  const chips = useMemo(
    () =>
      value.map((t, i) => (
        <span
          key={`${t}-${i}`}
          className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2 py-0.5 text-xs text-foreground"
        >
          {t}
          <button
            type="button"
            onClick={() => removeAt(i)}
            disabled={disabled}
            aria-label={`${translate('common:remove')} ${t}`}
            title={translate('common:remove')}
            className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[hsl(var(--muted))] disabled:opacity-50"
          >
            <X size={12} className="text-muted-foreground" />
          </button>
        </span>
      )),
    [removeAt, value, disabled, translate]
  );

  return (
    <div className={`min-h-[40px] rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--input))] px-2 py-2 ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips}
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="border-none focus-visible:ring-0 px-0 py-0 h-6 min-w-[8ch] flex-1"
        />
      </div>
    </div>
  );
};

export default TagInput;
