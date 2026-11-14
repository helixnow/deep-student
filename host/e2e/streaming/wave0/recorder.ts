/**
 * WAVE0 stream event recorder (X5). One record per (scenario, side, take).
 *
 * Records every frontend-visible backend event in emission order: channel name,
 * wire payload (the JSON the frontend parses), and its index. It never filters,
 * sorts, deduplicates or drops events, including cancel/error/audit events and
 * anything emitted after a terminal. `terminal` is a derived summary only; the raw
 * `events` array is the evidence that comparison runs on.
 *
 * Side A (Tauri) has no in-process host; its driver feeds events through `push`
 * from the same tap point (the window event bus) and gets the same record shape.
 */
import type { BackendEvent } from '../../../kernel/protocol.ts';
import type { LoggedRequest } from './llm-service.ts';
import { captureJson } from './wire-json.ts';

export const RECORD_FORMAT = 'x5.stream-record.v0';

/** dstu-core/src/events.rs:89–93 session_event_type; frontend TauriAdapter treats these as stream end. */
export const SESSION_TERMINALS = ['stream_complete', 'stream_error', 'stream_cancelled'] as const;
export type SessionTerminal = typeof SESSION_TERMINALS[number];

export interface RecordedEvent {
  index: number;
  channel: string;
  payload: unknown;
  /** Original wire text; null means unavailable/unsupported for precision proof. */
  payloadJson: string | null;
}

export interface RecordedStep {
  index: number;
  cmd: string;
  args: unknown;
  ok: boolean;
  /** Return value (ok) or error value (not ok), as the frontend sees it. */
  value: unknown;
  argsJson: string | null;
  valueJson: string | null;
  /** events.length when the invoke started / settled; events are never split per step. */
  eventsBefore: number;
  eventsAfter: number;
}

export interface TerminalSummary {
  /** `none` = no session terminal; `multiple` = more than one (both are findings, not normalised away). */
  kind: SessionTerminal | 'none' | 'multiple';
  /** Event indices of every session terminal, in order. */
  indices: number[];
  /** Events recorded after the first terminal (late emissions stay in `events`). */
  eventsAfterFirstTerminal: number;
}

export interface StreamRecord {
  format: typeof RECORD_FORMAT;
  scenario: string;
  /** `A` (Tauri+Rust) or `B` (Electron/Host+TS). */
  side: 'A' | 'B';
  /** Take label, e.g. `A1`, `A2`, `B`. Raw takes are kept side by side for C2 review. */
  take: string;
  llmScript: string | null;
  steps: RecordedStep[];
  events: RecordedEvent[];
  terminal: TerminalSummary;
  /** Exact provider traffic seen by this take's LLM service instance. */
  llmRequests: LoggedRequest[];
  /** Runner-injected LLM service origin (OS-chosen port). Known input, so a proven normalisation target. */
  llmOrigin?: string | null;
  /** Runner only: every provider stream had closed by the end of the take. */
  llmIdle?: boolean;
}

const isSessionChannel = (channel: string) => channel.startsWith('chat_v2_session_');

export function terminalOf(events: readonly RecordedEvent[]): TerminalSummary {
  const indices = events.filter(event => isSessionChannel(event.channel)
    && (SESSION_TERMINALS as readonly string[]).includes(String((event.payload as { eventType?: unknown } | null)?.eventType)))
    .map(event => event.index);
  const first = indices[0];
  return {
    kind: indices.length === 0 ? 'none' : indices.length > 1 ? 'multiple'
      : (events[first!]!.payload as { eventType: SessionTerminal }).eventType,
    indices,
    eventsAfterFirstTerminal: first === undefined ? 0 : events.length - first - 1,
  };
}

export class StreamRecorder {
  readonly events: RecordedEvent[] = [];
  readonly steps: RecordedStep[] = [];
  private readonly scenario: string;
  private readonly side: 'A' | 'B';
  private readonly take: string;
  private readonly llmScript: string | null;

  constructor(meta: { scenario: string; side: 'A' | 'B'; take: string; llmScript?: string | null }) {
    this.scenario = meta.scenario;
    this.side = meta.side;
    this.take = meta.take;
    this.llmScript = meta.llmScript ?? null;
  }

  /** Side A / generic tap: one call per emitted event, in emission order. */
  push(channel: string, payload: unknown, payloadJson?: string): void {
    const captured = captureJson(payload, payloadJson, false);
    this.events.push({ index: this.events.length, channel, payload: captured.value, payloadJson: captured.json });
  }

  /** Side B: copy kernel outbound events from `source[from..]` (the test host's ordered `events`). */
  pullHostEvents(source: readonly BackendEvent[], from: number): number {
    for (let i = from; i < source.length; i++) {
      const event = source[i]!;
      const captured = captureJson(event.payload, event.payloadJson, true);
      this.events.push({ index: this.events.length, channel: event.event, payload: captured.value, payloadJson: captured.json });
    }
    return source.length;
  }

  step(entry: Omit<RecordedStep, 'index' | 'argsJson' | 'valueJson'> & Partial<Pick<RecordedStep, 'argsJson' | 'valueJson'>>): RecordedStep {
    const args = captureJson(entry.args, entry.argsJson, this.side === 'B');
    const value = captureJson(entry.value, entry.valueJson, this.side === 'B');
    const recorded = { index: this.steps.length, ...entry, args: args.value, argsJson: args.json,
      value: value.value, valueJson: value.json };
    this.steps.push(recorded);
    return recorded;
  }

  finish(llmRequests: readonly LoggedRequest[] = []): StreamRecord {
    return {
      format: RECORD_FORMAT, scenario: this.scenario, side: this.side, take: this.take, llmScript: this.llmScript,
      steps: structuredClone(this.steps), events: structuredClone(this.events), terminal: terminalOf(this.events),
      llmRequests: structuredClone([...llmRequests]),
    };
  }
}
