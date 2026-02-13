import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Textarea } from '../components/ui/shad/Textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { cn } from './lib/cn';

type PromptInputContextType = {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

const PromptInputContext = createContext<PromptInputContextType | null>(null);

function usePromptInput() {
  const ctx = useContext(PromptInputContext);
  if (!ctx) throw new Error('usePromptInput must be used within a PromptInput');
  return ctx;
}

export type PromptInputProps = {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number | string;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
};

export function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled,
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  return (
    <TooltipProvider>
      <PromptInputContext.Provider
        value={{
          isLoading,
          value: value ?? internalValue,
          setValue: onValueChange ?? handleChange,
          maxHeight,
          onSubmit,
          disabled,
          textareaRef,
        }}
      >
        <div
          className={cn(
            'border-input bg-white/90 dark:bg-slate-900/50 backdrop-blur-md cursor-text rounded-3xl border p-2 shadow-[0_20px_40px_hsl(var(--foreground)_/_0.06)]',
            className,
          )}
          onClick={() => textareaRef.current?.focus()}
        >
          {children}
        </div>
      </PromptInputContext.Provider>
    </TooltipProvider>
  );
}

export type PromptInputTextareaProps = {
  disableAutosize?: boolean;
} & React.ComponentProps<typeof Textarea>;

export function PromptInputTextarea({
  className,
  onKeyDown,
  disableAutosize = false,
  ...props
}: PromptInputTextareaProps) {
  const { value, setValue, maxHeight, onSubmit, disabled, textareaRef } = usePromptInput();

  useEffect(() => {
    if (disableAutosize) return;
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height =
      typeof maxHeight === 'number'
        ? `${Math.min(textareaRef.current.scrollHeight, maxHeight)}px`
        : `min(${textareaRef.current.scrollHeight}px, ${maxHeight})`;
  }, [value, maxHeight, disableAutosize]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const anyNative: any = e.nativeEvent as any;
    const composing = Boolean((e as any).isComposing || (anyNative && anyNative.isComposing) || (e as any).which === 229);
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault();
      onSubmit?.();
    }
    onKeyDown?.(e);
  };

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className={cn(
        'min-h-[44px] w-full resize-none border-none bg-transparent text-[15px] shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
        className,
      )}
      rows={1}
      disabled={disabled}
      {...props}
    />
  );
}

export type PromptInputActionsProps = React.HTMLAttributes<HTMLDivElement>;

export function PromptInputActions({ children, className, ...props }: PromptInputActionsProps) {
  return (
    <div className={cn('flex items-center gap-2', className)} {...props}>
      {children}
    </div>
  );
}

export type PromptInputActionProps = {
  className?: string;
  tooltip: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
} & React.ComponentProps<typeof Tooltip>;

export function PromptInputAction({ tooltip, children, className, side, ...props }: PromptInputActionProps) {
  const { disabled } = usePromptInput();
  return (
    <Tooltip {...props}>
      {/* @ts-expect-error - TooltipTrigger asChild 类型问题 */}
      <TooltipTrigger asChild onClick={(e: any) => e.stopPropagation()}>{children}</TooltipTrigger>
      {/* @ts-expect-error - TooltipContent side 类型问题 */}
      <TooltipContent className={className} side={side}>{!disabled && tooltip}</TooltipContent>
    </Tooltip>
  );
}
