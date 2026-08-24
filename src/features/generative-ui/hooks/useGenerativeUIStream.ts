import { useCallback, useMemo, useState } from 'react';
import { GenerativeUIStreamParser } from '../parser';
import { parseGenerativeUIIntent, isGenerativeUIParseFailure } from '../schema';
import { coercePartialIntent } from '../utils/coercePartialIntent';
import type { GenerativeUIIntent } from '../types';

export interface UseGenerativeUIStreamOptions {
  /** 流式结束时的最终 JSON */
  onComplete?: (intent: GenerativeUIIntent | null) => void;
}

export interface UseGenerativeUIStreamResult {
  intent: GenerativeUIIntent | null;
  partialIntent: GenerativeUIIntent | null;
  isStreaming: boolean;
  errors: string[];
  append: (chunk: string) => void;
  reset: () => void;
  finalize: () => GenerativeUIIntent | null;
  setIntent: (raw: string | GenerativeUIIntent) => void;
}

export function useGenerativeUIStream(
  options: UseGenerativeUIStreamOptions = {},
): UseGenerativeUIStreamResult {
  const [parser] = useState(() => new GenerativeUIStreamParser());
  const [partialIntent, setPartialIntent] = useState<GenerativeUIIntent | null>(null);
  const [intent, setIntentState] = useState<GenerativeUIIntent | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const append = useCallback(
    (chunk: string) => {
      setIsStreaming(true);
      const partial = parser.append(chunk);
      if (partial) setPartialIntent(partial);
    },
    [parser],
  );

  const reset = useCallback(() => {
    parser.reset();
    setPartialIntent(null);
    setIntentState(null);
    setIsStreaming(false);
    setErrors([]);
  }, [parser]);

  const finalize = useCallback(() => {
    setIsStreaming(false);
    const finalPartial = parser.finalize();
    const buffer = parser.getBuffer().trim();
    if (buffer) {
      const parsed = parseGenerativeUIIntent(buffer);
      if (isGenerativeUIParseFailure(parsed)) {
        const recovered = finalPartial ?? coercePartialIntent(buffer).intent;
        setErrors(parsed.errors);
        if (recovered) setPartialIntent(recovered);
        options.onComplete?.(recovered);
        return recovered;
      }
      setIntentState(parsed.intent);
      setPartialIntent(parsed.intent);
      setErrors([]);
      options.onComplete?.(parsed.intent);
      return parsed.intent;
    }
    options.onComplete?.(finalPartial);
    return finalPartial;
  }, [parser, options]);

  const setIntent = useCallback((raw: string | GenerativeUIIntent) => {
    if (typeof raw === 'string') {
      const parsed = parseGenerativeUIIntent(raw);
      if (isGenerativeUIParseFailure(parsed)) {
        setErrors(parsed.errors);
        return;
      }
      setIntentState(parsed.intent);
      setPartialIntent(parsed.intent);
      setErrors([]);
      return;
    }
    setIntentState(raw);
    setPartialIntent(raw);
    setErrors([]);
  }, []);

  const displayIntent = useMemo(
    () => (isStreaming ? partialIntent ?? intent : intent ?? partialIntent),
    [intent, partialIntent, isStreaming],
  );

  return {
    intent: displayIntent,
    partialIntent,
    isStreaming,
    errors,
    append,
    reset,
    finalize,
    setIntent,
  };
}
