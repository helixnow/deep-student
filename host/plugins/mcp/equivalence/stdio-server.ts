/**
 * WAVE0 deterministic MCP stdio server (JSONL framing, the MCP default).
 *
 *   <node> host/plugins/mcp/equivalence/stdio-server.ts <scriptId> [--log <file.jsonl>]
 *
 * Use `McpService.stdioLaunch(scriptId)` to get the exact command/args/env/cwd for both
 * backends; it picks a Node runtime that really runs as Node (see `runtime.ts`).
 * Every inbound line is appended to the log file as one `MessageRecord` before the reply is
 * written; start/exit are `LifecycleRecord`s. The process exits on stdin EOF (the client
 * closed the session), on SIGTERM/SIGINT, or when a `disconnect-*` script fires.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { handleMessage, isScriptId, replyText, SCRIPT_IDS, type FixtureRecord, type ScriptId } from './protocol.ts';

export interface StdioServerOptions {
  /** JSONL record file shared by all children of one service; null = do not log. */
  logFile: string | null;
}

function writeRecord(logFile: string | null, record: FixtureRecord): void {
  // One appendFileSync per record keeps each line atomic and in arrival order across children.
  if (logFile !== null) appendFileSync(logFile, `${JSON.stringify(record)}\n`);
}

export function runStdioServer(script: ScriptId, options: StdioServerOptions): void {
  const { logFile } = options;
  const session = process.pid;
  let exiting = false;
  const lifecycle = (event: 'start' | 'exit', reason: string | null): void => {
    writeRecord(logFile, { kind: 'lifecycle', transport: 'stdio', script, session, event, reason, detail: event === 'start' ? { argv: process.argv.slice(2) } : null });
  };
  const exit = (reason: string, signal: NodeJS.Signals | null): void => {
    if (exiting) return;
    exiting = true;
    lifecycle('exit', reason);
    if (signal === null) {
      process.stdout.write('', () => { process.exit(0); });
      return;
    }
    // Keep the default signal termination (exit status = signal) instead of turning it into exit 0.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  };

  lifecycle('start', null);
  process.once('SIGTERM', () => { exit('sigterm', 'SIGTERM'); });
  process.once('SIGINT', () => { exit('sigint', 'SIGINT'); });

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (exiting) return;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue;
      const handled = handleMessage(script, line);
      const texts = handled.replies.map(replyText);
      writeRecord(logFile, {
        kind: 'message', transport: 'stdio', script, session,
        method: handled.method, id: handled.id, params: handled.params, raw: line, outcome: handled.outcome, replies: texts, headers: null,
      });
      for (const reply of handled.replies) {
        if (reply.kind === 'disconnect') { exit('disconnect-script', null); return; }
        const value = replyText(reply);
        if (value !== null) process.stdout.write(`${value}\n`);
      }
    }
  });
  process.stdin.on('end', () => { exit('stdin-end', null); });
}

function main(argv: string[]): void {
  const [script, ...rest] = argv;
  const logIndex = rest.indexOf('--log');
  const logFile = logIndex >= 0 ? rest[logIndex + 1] ?? null : null;
  if (script === undefined || !isScriptId(script)) {
    writeRecord(logFile, { kind: 'lifecycle', transport: 'stdio', script: String(script), session: process.pid, event: 'config-error', reason: 'unknown-script', detail: { known: SCRIPT_IDS } });
    process.stderr.write(`mcp stdio fixture: unknown script ${JSON.stringify(script ?? null)}; known: ${SCRIPT_IDS.join(', ')}\n`);
    process.exit(2);
  }
  runStdioServer(script, { logFile });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
