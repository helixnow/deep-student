/**
 * Generative UI action telemetry — 薄封装现有 GenerativeActionDefinition。
 * 项目内无统一 trackEvent / analytics，默认走可注入 sink（console.debug）。
 */

import type { GenerativeActionDefinition, RiskLevel } from '../types';

export type GenerativeActionTelemetryPhase = 'execute' | 'undo';

export interface GenerativeActionTelemetryEvent {
  actionId: string;
  riskLevel: RiskLevel;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  error?: unknown;
  phase?: GenerativeActionTelemetryPhase;
  /** 可选 intent fingerprint，不影响既有 sink 必填字段 */
  fingerprint?: string;
}

export interface WrapActionWithTelemetryExtras {
  fingerprint?: string;
}

export type GenerativeActionTelemetrySink = (event: GenerativeActionTelemetryEvent) => void;

export function defaultGenerativeActionTelemetrySink(
  event: GenerativeActionTelemetryEvent,
): void {
  console.debug('[generative-ui:action]', event);
}

export function emitGenerativeActionTelemetry(
  event: GenerativeActionTelemetryEvent,
  sink: GenerativeActionTelemetrySink = defaultGenerativeActionTelemetrySink,
): void {
  sink(event);
}

function attachOptionalFingerprint(
  event: GenerativeActionTelemetryEvent,
  fingerprint?: string,
): GenerativeActionTelemetryEvent {
  if (typeof fingerprint === 'string' && fingerprint.length > 0) {
    return { ...event, fingerprint };
  }
  return event;
}

/**
 * 记录 actionId / riskLevel / startedAt / durationMs / ok|error。
 * 错误先写入 sink，再原样 rethrow，不吞异常。
 */
export function wrapActionWithTelemetry(
  def: GenerativeActionDefinition,
  sink: GenerativeActionTelemetrySink = defaultGenerativeActionTelemetrySink,
  extras?: WrapActionWithTelemetryExtras,
): GenerativeActionDefinition {
  return {
    ...def,
    handler: async (payload) => {
      const startedAt = Date.now();
      try {
        const result = await def.handler(payload);
        emitGenerativeActionTelemetry(
          attachOptionalFingerprint(
            {
              actionId: def.id,
              riskLevel: def.riskLevel,
              startedAt,
              durationMs: Date.now() - startedAt,
              ok: true,
              phase: 'execute',
            },
            extras?.fingerprint,
          ),
          sink,
        );
        return result;
      } catch (error) {
        emitGenerativeActionTelemetry(
          attachOptionalFingerprint(
            {
              actionId: def.id,
              riskLevel: def.riskLevel,
              startedAt,
              durationMs: Date.now() - startedAt,
              ok: false,
              error,
              phase: 'execute',
            },
            extras?.fingerprint,
          ),
          sink,
        );
        throw error;
      }
    },
  };
}
