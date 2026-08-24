import { useCallback, useMemo, useState } from 'react';
import { GenerativeUIStreamParser } from '../parser';
import {
  generativeUIIntentSchema,
  parseGenerativeUIIntent,
  isGenerativeUIParseFailure,
} from '../schema';
import { coercePartialIntent } from '../utils/coercePartialIntent';
import {
  classifyGenerativeUIParseErrors,
  type ClassifiedGenerativeUIParseError,
} from '../utils/classifyGenerativeUIParseErrors';
import { pushDefaultGenerativeUIIntentSnapshot } from '../utils/intentSnapshotRing';
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
  errorCodes: ClassifiedGenerativeUIParseError[];
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
      if (chunk) setErrors([]);
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
      pushDefaultGenerativeUIIntentSnapshot(parsed.intent);
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
      pushDefaultGenerativeUIIntentSnapshot(parsed.intent);
      return;
    }
    const validated = generativeUIIntentSchema.safeParse(raw);
    if (!validated.success) {
      setErrors(validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
      return;
    }
    const validatedIntent = validated.data as GenerativeUIIntent;
    setIntentState(validatedIntent);
    setPartialIntent(validatedIntent);
    setErrors([]);
    pushDefaultGenerativeUIIntentSnapshot(validatedIntent);
  }, []);

  const displayIntent = useMemo(
    () => (isStreaming ? partialIntent ?? intent : intent ?? partialIntent),
    [intent, partialIntent, isStreaming],
  );

  const errorCodes = useMemo(
    () => classifyGenerativeUIParseErrors(errors),
    [errors],
  );

  return {
    intent: displayIntent,
    partialIntent,
    isStreaming,
    errors,
    errorCodes,
    append,
    reset,
    finalize,
    setIntent,
  };
}
