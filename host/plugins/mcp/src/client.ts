// Production MCP client built on the JSON-RPC dispatch and transport modules.
// Mirrors `dstu-mcp/src/mcp/global.rs::initialize_global_mcp_client`.

import type { McpClient, McpTool, McpToolResult } from '../api.ts';
import type { McpConfig } from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import { parseVersion } from './protocol-version.ts';
import type { McpEvent } from './client-dispatch.ts';
import {
  createTransportForConfig, JsonRpcProbe, type ProbeServer, type Transport,
} from './probe.ts';

export type McpClientLog = (level: 'info' | 'warn' | 'error', message: string) => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HostMcpClient implements McpClient {
  private readonly rpc: JsonRpcProbe;
  private readonly transport: Transport;

  constructor(rpc: JsonRpcProbe, transport: Transport) {
    this.rpc = rpc;
    this.transport = transport;
  }

  listTools(): Promise<McpTool[]> {
    return this.rpc.listToolSpecs();
  }

  callTool(name: string, arguments_: Parameters<McpClient['callTool']>[1]): Promise<McpToolResult> {
    return this.rpc.callTool(name, arguments_);
  }

  isConnected(): boolean {
    return this.rpc.isConnected();
  }

  /** Rust `McpClient::on_event`. */
  onEvent(handler: (event: McpEvent) => void): void {
    this.rpc.onEvent(handler);
  }

  async disconnect(): Promise<void> {
    await this.rpc.close();
  }
}

/** `initialize_global_mcp_client`: create transport, connect, initialize, return client. */
export async function connectMcpClient(
  config: McpConfig, log: McpClientLog, onToolsChanged?: () => void,
): Promise<McpClient> {
  let transport: Transport;
  try {
    transport = await createTransportForConfig(config.transport, log);
  } catch (error) {
    log('error', `Failed to connect MCP client: ${errorText(error)}`);
    throw error;
  }

  const rpc = new JsonRpcProbe(transport, {
    clientName: 'deep-student',
    clientVersion: '1.0.0',
    protocolVersion: config.protocol_version,
    timeoutMs: config.performance.timeout_ms,
    log,
  });
  rpc.start();

  let server: ProbeServer;
  try {
    server = await rpc.initialize();
  } catch (error) {
    log('error', `Failed to initialize MCP client: ${errorText(error)}`);
    await rpc.close();
    throw error;
  }

  if (server.protocol_version === '') {
    log('warn', '[McpClient] Server did not return protocolVersion (required by MCP spec). '
      + 'Proceeding with best-effort compatibility.');
  } else if (parseVersion(server.protocol_version) === null) {
    log('warn', `[McpClient] Server returned unsupported protocol version: '${server.protocol_version}'. `
      + 'Supported versions: 2024-11-05, 2025-03-26, 2025-06-18. '
      + 'Proceeding with best-effort compatibility.');
  }
  log('info', `MCP client connected to server: ${server.name} v${server.version}`);
  const client = new HostMcpClient(rpc, transport);
  if (onToolsChanged !== undefined) {
    client.onEvent(event => { if (event.type === 'ToolsChanged') onToolsChanged(); });
  }
  return client;
}

export { HostMcpClient };
