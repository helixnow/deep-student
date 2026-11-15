// Desktop transports add the local child process to the portable MCP client.
import type { JsonValue } from '../api.ts';
import type { McpTransportConfig } from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import { createRemoteTransportForConfig, probeTransport, type ProgressCallback, type Transport } from './probe-core.ts';
import { createStdioTransport, readStdioStdout, type StdioLog } from './stdio-proxy.ts';

export * from './probe-core.ts';

type TransportWaiter = { resolve(value: string): void; reject(error: Error): void };
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function createTransportForConfig(config: McpTransportConfig, log?: StdioLog): Promise<Transport> {
  if (config.type === 'stdio') {
    return stdioTransport(config.command, config.args, config.env, config.working_dir ?? null, config.framing, log);
  }
  return createRemoteTransportForConfig(config);
}

// ---------------------------------------------------------------- stdio

async function stdioTransport(
  command: string, args: string[], env: Record<string, string>, cwd: string | null,
  framing: 'jsonl' | 'content_length',
  log?: StdioLog,
): Promise<Transport> {
  const transport = await createStdioTransport(command, args, framing, env, cwd, { log });
  const pending: string[] = [];
  const waiters: TransportWaiter[] = [];
  let ended = false;
  const push = (message: string): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(message);
    else pending.push(message);
  };
  const finish = (): void => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Transport error: Channel closed'));
  };
  void readStdioStdout(transport.child.stdout, framing, transport.command, push, log).then(finish, error => {
    log?.('error', `Error reading from MCP stdout: ${errorText(error)}`);
    finish();
  });
  return {
    label: 'stdio',
    async send(message: string): Promise<void> { transport.send(message); },
    receive(): Promise<string> {
      const next = pending.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (ended) return Promise.reject(new Error('Transport error: Channel closed'));
      return new Promise<string>((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
    async close(): Promise<void> {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('Transport error: Channel closed'));
      await transport.close();
    },
  };
}

export async function testStdio(
  command: string, args: string[], env: Record<string, string>, cwd: string | null,
  framing: string | null, onProgress: ProgressCallback, log?: StdioLog,
): Promise<JsonValue> {
  onProgress('spawn_process');
  const normalizedArgs = args.map(value => value.trim()).filter(value => value !== '');
  const mode = ['content_length', 'content-length', 'contentlength'].includes(framing ?? '')
    ? 'content_length' : 'jsonl';
  let transport: Transport;
  try {
    transport = await stdioTransport(command, normalizedArgs, env, cwd, mode, log);
  } catch (error) {
    return { success: false, transport: 'stdio', error: `无法启动进程: ${errorText(error)}` };
  }
  return probeTransport(transport, 'stdio', onProgress, log);
}
