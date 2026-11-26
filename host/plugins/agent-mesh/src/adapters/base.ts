// Shared streaming, line-framing, ephemeral config, and turn-bookkeeping utilities
// used by all concrete external CLI adapters.

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { NormalizedRuntimeEvent } from '../adapter-types.ts';

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private readonly onPush?: (item: T) => void;
  private closed = false;

  constructor(onPush?: (item: T) => void) {
    this.onPush = onPush;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    this.onPush?.(item);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.buffer.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          const item = this.buffer.shift()!;
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class LineStreamSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private remainder = '';
  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  feed(chunk: Buffer | string): void {
    this.remainder += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newlineIndex = this.remainder.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = this.remainder.slice(0, newlineIndex);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      this.remainder = this.remainder.slice(newlineIndex + 1);
      this.onLine(line);
      newlineIndex = this.remainder.indexOf('\n');
    }
  }

  flush(): void {
    this.remainder += this.decoder.end();
    if (this.remainder.length > 0) {
      const trailing = this.remainder.endsWith('\r')
        ? this.remainder.slice(0, -1)
        : this.remainder;
      this.remainder = '';
      if (trailing.length > 0) {
        this.onLine(trailing);
      }
    }
  }
}

export function attachLineReader(
  stream: Readable | null,
  onLine: (line: string) => void,
): { flush: () => void } {
  const splitter = new LineStreamSplitter(onLine);
  if (!stream) {
    return { flush: () => splitter.flush() };
  }
  stream.on('data', (chunk: Buffer | string) => {
    splitter.feed(chunk);
  });
  stream.once('end', () => {
    splitter.flush();
  });
  return { flush: () => splitter.flush() };
}

export function tryParseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? null : null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function extractApprovalMetadata(
  toolName: string,
  rawInput?: Readonly<Record<string, unknown>>,
): { targetPath?: string; command?: string } {
  if (!rawInput) return {};
  const pathKeys = ['file_path', 'path', 'target_file', 'targetPath', 'filePath', 'notebook_path'];
  let targetPath: string | undefined;
  for (const key of pathKeys) {
    const candidate = rawInput[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      targetPath = candidate;
      break;
    }
  }
  if (!targetPath && Array.isArray(rawInput.changes)) {
    const firstChange = asRecord(rawInput.changes[0]);
    if (firstChange && typeof firstChange.path === 'string') {
      targetPath = firstChange.path;
    }
  }

  let command: string | undefined;
  if (typeof rawInput.command === 'string' && rawInput.command.trim().length > 0) {
    command = rawInput.command;
  } else if (Array.isArray(rawInput.command)) {
    command = rawInput.command.map((part) => String(part)).join(' ');
  } else if (typeof rawInput.cmd === 'string' && rawInput.cmd.trim().length > 0) {
    command = rawInput.cmd;
  } else if (toolName.toLowerCase().includes('bash') && typeof rawInput.input === 'string') {
    command = rawInput.input;
  }

  return { targetPath, command };
}

export async function writeEphemeralJsonFile(
  prefix: string,
  payload: unknown,
): Promise<{ dirPath: string; filePath: string; cleanup: () => Promise<void> }> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), `dstu-mesh-${prefix}-`));
  const filePath = path.join(dirPath, 'config.json');
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  const cleanup = async (): Promise<void> => {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch (err) {
      if (err instanceof Error) {
        // Temp directory already removed.
      }
    }
  };
  return { dirPath, filePath, cleanup };
}

export function isTerminalRuntimeEvent(event: NormalizedRuntimeEvent): boolean {
  return (
    event.type === 'quiescent_completed' ||
    event.type === 'turn_interrupted'
  );
}
