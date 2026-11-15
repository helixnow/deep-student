import type { McpConfig } from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import { connectMcpClient as connect, type McpClientLog } from './client-core.ts';
import { createTransportForConfig } from './probe.ts';

export { HostMcpClient, type McpClientLog } from './client-core.ts';

export function connectMcpClient(config: McpConfig, log: McpClientLog, onToolsChanged?: () => void) {
  return connect(config, log, onToolsChanged, createTransportForConfig);
}
