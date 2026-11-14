/** Offsets are JavaScript UTF-16 code units, except toolOffset (trace count). */
export interface ResponseSegment {
  readonly textOffset: number;
  readonly reasoningOffset: number;
  readonly toolOffset: number;
  readonly startedAt: number;
}

export function toolTraceId(taskId: string, roundIndex: number, callIndex: number): string {
  return `${taskId}:${roundIndex}:${callIndex}`;
}

export type ToolBatchDisposition<T> =
  | { interrupted: false; toolCalls: readonly T[] }
  | { interrupted: true; resumable: true; reason: 'truncated_tool_batch'; toolCalls: readonly [] };

/** A syntactically valid argument prefix still must not execute after truncation. */
export function rejectTruncatedToolBatch<T>(
  finishReason: string | null | undefined, toolCalls: readonly T[],
): ToolBatchDisposition<T> {
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    return { interrupted: true, resumable: true, reason: 'truncated_tool_batch', toolCalls: [] };
  }
  return { interrupted: false, toolCalls };
}

/** Incremental fence parsing holds only an unfinished fence, never rewrites delivered text. */
export class ArtifactReferenceDeduplicator {
  private pending = '';
  private readonly seen = new Set<string>();

  append(delta: string, final = false): string {
    this.pending += delta;
    let output = '';
    while (this.pending) {
      const opening = /(^|\n)( {0,3})(`{3,}|~{3,})([^\n]*)\n/.exec(this.pending);
      if (!opening) {
        // A partial opening line may arrive one token at a time.
        const lineStart = this.pending.lastIndexOf('\n') + 1;
        const tail = this.pending.slice(lineStart);
        const hold = !final && /^ {0,3}[`~]/.test(tail);
        output += this.pending.slice(0, hold ? lineStart : undefined);
        this.pending = hold ? tail : '';
        break;
      }
      const start = opening.index + opening[1]!.length;
      output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      const headerLength = opening[0].length - opening[1]!.length;
      const marker = opening[3]!;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?=\\n|$)`, 'm');
      const body = this.pending.slice(headerLength);
      const end = closing.exec(body);
      if (!end) {
        if (final) { output += this.pending; this.pending = ''; }
        break;
      }
      const length = headerLength + end.index + end[0].length;
      const fence = this.pending.slice(0, length);
      const kind = opening[4]!.trim();
      const key = `${kind}:${body.slice(0, end.index).trim()}`;
      if (/^wbw-(widget|whiteboard|canvas)$/.test(kind)) {
        // Replace by code unit, not code point: emoji references also retain offsets.
        output += this.seen.has(key) ? fence.replace(/[^\r\n]/g, ' ') : fence;
        this.seen.add(key);
      } else {
        output += fence;
      }
      this.pending = this.pending.slice(length);
    }
    return output;
  }
}

export class ResponseTimeline<T extends { id?: string } = { id?: string }> {
  private content = '';
  private thought = '';
  private readonly traces: Array<Omit<T, 'id'> & { id: string }> = [];
  private readonly anchors: ResponseSegment[] = [];
  private readonly references = new ArtifactReferenceDeduplicator();
  private activity: 'text' | 'process' = 'process';
  private readonly callCounts = new Map<number, number>();
  readonly taskId: string;
  private readonly now: () => number;

  constructor(taskId: string, now: () => number = Date.now) {
    this.taskId = taskId;
    this.now = now;
    this.anchor();
  }

  get text(): string { return this.content; }
  get reasoning(): string { return this.thought; }
  get textOffset(): number { return this.content.length; }
  get reasoningOffset(): number { return this.thought.length; }
  get toolOffset(): number { return this.traces.length; }
  get segments(): readonly ResponseSegment[] { return this.anchors.slice(); }
  get tools(): ReadonlyArray<Omit<T, 'id'> & { id: string }> { return this.traces.slice(); }

  appendText(delta: string): void {
    if (!delta) return;
    this.content += this.references.append(delta);
    this.activity = 'text';
  }

  /** Flush an unfinished ordinary fence at the end of the response. */
  finishText(): void { this.content += this.references.append('', true); }

  appendReasoning(delta: string): void {
    if (!delta) return;
    this.beginActivity();
    this.thought += delta;
  }

  appendTool(call: T, roundIndex: number): Omit<T, 'id'> & { id: string } {
    this.beginActivity();
    const index = this.callCounts.get(roundIndex) ?? 0;
    this.callCounts.set(roundIndex, index + 1);
    const trace = { ...call, id: toolTraceId(this.taskId, roundIndex, index) };
    this.traces.push(trace);
    return trace;
  }

  private beginActivity(): void {
    if (this.activity === 'text') {
      this.finishText();
      this.anchor();
    }
    this.activity = 'process';
  }

  private anchor(): void {
    this.anchors.push(Object.freeze({ textOffset: this.textOffset,
      reasoningOffset: this.reasoningOffset, toolOffset: this.toolOffset, startedAt: this.now() }));
  }
}
