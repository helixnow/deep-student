/**
 * Generative UI action telemetry ring — recent events for debug / Style Lab.
 * Standalone store; does not change the default console sink.
 */

import type { GenerativeActionTelemetryEvent } from './actionTelemetry';

export const GENERATIVE_ACTION_TELEMETRY_RING_LIMIT = 50;

export class GenerativeActionTelemetryRing {
  private readonly events: GenerativeActionTelemetryEvent[] = [];
  private readonly limit: number;

  constructor(limit?: number) {
    this.limit = limit ?? GENERATIVE_ACTION_TELEMETRY_RING_LIMIT;
  }

  get size(): number {
    return this.events.length;
  }

  push(event: GenerativeActionTelemetryEvent): void {
    this.events.push(event);
    while (this.events.length > this.limit) {
      this.events.shift();
    }
  }

  /** Oldest → newest. Shallow copy — mutating the return must not change the store. */
  list(): GenerativeActionTelemetryEvent[] {
    return this.events.slice();
  }

  latest(): GenerativeActionTelemetryEvent | undefined {
    return this.events[this.events.length - 1];
  }

  clear(): void {
    this.events.length = 0;
  }
}

let defaultRing: GenerativeActionTelemetryRing | null = null;

export function getDefaultGenerativeActionTelemetryRing(): GenerativeActionTelemetryRing {
  if (!defaultRing) {
    defaultRing = new GenerativeActionTelemetryRing();
  }
  return defaultRing;
}

export function resetDefaultGenerativeActionTelemetryRing(): void {
  defaultRing = new GenerativeActionTelemetryRing();
}

export function pushDefaultGenerativeActionTelemetry(
  event: GenerativeActionTelemetryEvent,
): void {
  getDefaultGenerativeActionTelemetryRing().push(event);
}
