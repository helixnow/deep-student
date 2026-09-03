/**
 * Generative UI action undo stack — SOTA HITL 可撤销栈。
 * handler 可返回 `{ undo }`，或在 definition 上挂独立 `undo` 字段。
 */

import type { GenerativeActionDefinition, RiskLevel } from '../types';
import {
  defaultGenerativeActionTelemetrySink,
  emitGenerativeActionTelemetry,
  type GenerativeActionTelemetrySink,
} from './actionTelemetry';

export const GENERATIVE_ACTION_UNDO_STACK_LIMIT = 20;

export type GenerativeActionUndoFn = () => void | Promise<void>;

export type GenerativeActionHandlerResult = void | { undo?: GenerativeActionUndoFn };

export interface ReversibleGenerativeActionDefinition extends GenerativeActionDefinition {
  undo?: GenerativeActionUndoFn;
}

export interface GenerativeActionUndoEntry {
  actionId: string;
  riskLevel?: RiskLevel;
  undo: GenerativeActionUndoFn;
}

export interface GenerativeActionUndoStackOptions {
  limit?: number;
  sink?: GenerativeActionTelemetrySink;
}

function isUndoResult(value: unknown): value is { undo?: GenerativeActionUndoFn } {
  return value != null && typeof value === 'object' && 'undo' in (value as object);
}

/** 优先取 handler 返回值上的 undo，其次 definition.undo */
export function resolveGenerativeActionUndo(
  def: Pick<GenerativeActionDefinition, 'undo'>,
  result?: unknown,
): GenerativeActionUndoFn | undefined {
  if (isUndoResult(result) && typeof result.undo === 'function') {
    return result.undo;
  }
  if (typeof def.undo === 'function') {
    return def.undo;
  }
  return undefined;
}

export class GenerativeActionUndoStack {
  private readonly entries: GenerativeActionUndoEntry[] = [];
  private readonly limit: number;
  private readonly sink: GenerativeActionTelemetrySink;

  constructor(options: GenerativeActionUndoStackOptions = {}) {
    this.limit = options.limit ?? GENERATIVE_ACTION_UNDO_STACK_LIMIT;
    this.sink = options.sink ?? defaultGenerativeActionTelemetrySink;
  }

  get size(): number {
    return this.entries.length;
  }

  push(entry: GenerativeActionUndoEntry): void {
    if (typeof entry.undo !== 'function') return;
    this.entries.push(entry);
    while (this.entries.length > this.limit) {
      this.entries.shift();
    }
  }

  canUndo(): boolean {
    return this.entries.length > 0;
  }

  clear(): void {
    this.entries.length = 0;
  }

  async undo(): Promise<boolean> {
    const entry = this.entries.pop();
    if (!entry) return false;

    const startedAt = Date.now();
    try {
      await entry.undo();
      emitGenerativeActionTelemetry(
        {
          actionId: entry.actionId,
          riskLevel: entry.riskLevel ?? 'low',
          startedAt,
          durationMs: Date.now() - startedAt,
          ok: true,
          phase: 'undo',
        },
        this.sink,
      );
      return true;
    } catch (error) {
      emitGenerativeActionTelemetry(
        {
          actionId: entry.actionId,
          riskLevel: entry.riskLevel ?? 'low',
          startedAt,
          durationMs: Date.now() - startedAt,
          ok: false,
          error,
          phase: 'undo',
        },
        this.sink,
      );
      throw error;
    }
  }
}

let defaultStack: GenerativeActionUndoStack | null = null;

export function getDefaultGenerativeActionUndoStack(): GenerativeActionUndoStack {
  if (!defaultStack) {
    defaultStack = new GenerativeActionUndoStack();
  }
  return defaultStack;
}

export function resetDefaultGenerativeActionUndoStack(): GenerativeActionUndoStack {
  defaultStack = new GenerativeActionUndoStack();
  return defaultStack;
}

/**
 * 用 execute/undo 包装现有 definition，handler 成功后返回 `{ undo }`。
 */
export function wrapReversibleAction(
  def: GenerativeActionDefinition,
  ops: {
    execute: (
      payload?: Record<string, unknown>,
    ) => GenerativeActionHandlerResult | Promise<GenerativeActionHandlerResult>;
    undo: GenerativeActionUndoFn;
  },
): ReversibleGenerativeActionDefinition {
  return {
    ...def,
    undo: ops.undo,
    handler: async (payload) => {
      const result = await ops.execute(payload);
      const fromResult = resolveGenerativeActionUndo({}, result);
      return { undo: fromResult ?? ops.undo };
    },
  };
}
