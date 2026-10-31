import type { McpToolConfig } from '../hookDepsTypes';
import type { McpTestResult } from './types';

export const normalizeFrontendResult = (r: Record<string, unknown> | null | undefined): McpTestResult => ({ success: !!r?.success, tools_count: typeof r?.tools_count === 'number' ? r.tools_count : (Array.isArray(r?.tools) ? r.tools.length : undefined), tools: Array.isArray(r?.tools) ? r.tools as McpTestResult['tools'] : undefined });

export const resolveServerId = (tool: McpToolConfig, idx: number): string => {
  const transport = (tool?.transportType || 'sse') as string;
  const directId = tool?.id || tool?.name;
  if (directId) return String(directId);
  const fromServers = tool?.mcpServers ? Object.values(tool.mcpServers).find((srv) => srv && typeof srv === 'object' && 'url' in (srv as Record<string, unknown>)) as Record<string, unknown> | undefined : undefined;
  if (transport === 'websocket') {
    if (tool?.url) return String(tool.url);
  } else if (transport === 'streamable_http') {
    const httpUrl = tool?.fetch?.url || tool?.endpoint || tool?.url || (fromServers ? fromServers.url : undefined);
    if (httpUrl) return String(httpUrl);
  } else if (transport === 'sse') {
    const sseUrl = tool?.fetch?.url || tool?.endpoint || (fromServers ? fromServers.url : undefined) || tool?.url;
    if (sseUrl) return String(sseUrl);
  }
  if (tool?.command) {
    const args = Array.isArray(tool.args) ? tool.args.join(',') : (tool.args || '');
    return `${tool.command}:${args}`;
  }
  return `mcp_${idx}`;
};

export const buildToolJson = (tool: McpToolConfig) => {
  if (tool?.mcpServers) {
    return JSON.stringify({ mcpServers: tool.mcpServers }, null, 2);
  }
  const serverKey = tool?.name || tool?.id || 'mcp_server';
  const config: Record<string, Record<string, Record<string, unknown>>> = {};
  if (tool?.fetch) {
    config.mcpServers = {
      [serverKey]: {
        type: tool.fetch.type,
        url: tool.fetch.url,
      },
    };
  } else if (tool?.transportType === 'websocket') {
    config.mcpServers = {
      [serverKey]: {
        type: 'websocket',
        url: tool.url,
      },
    };
  } else if (tool?.transportType === 'sse' || tool?.transportType === 'streamable_http') {
    config.mcpServers = {
      [serverKey]: {
        type: tool.transportType,
        url: tool.endpoint || tool.url || '',
      },
    };
  } else if (tool?.transportType === 'stdio') {
    config.mcpServers = {
      [serverKey]: {
        command: tool.command,
    args: Array.isArray(tool.args) ? tool.args : (typeof tool.args === 'string' && tool.args.includes(',') ? tool.args.split(',').map((item: string) => item.trim()).filter((item: string) => item.length > 0) : (typeof tool.args === 'string' && tool.args.length > 0 ? [tool.args.trim()] : [])),
      },
    };
  }
  if (tool?.apiKey && typeof tool.apiKey === 'string') {
    config.mcpServers = config.mcpServers || { [serverKey]: {} };
    config.mcpServers[serverKey].apiKey = tool.apiKey;
  }
  if (tool?.namespace && typeof tool.namespace === 'string') {
    config.mcpServers = config.mcpServers || { [serverKey]: {} };
    config.mcpServers[serverKey].namespace = tool.namespace;
  }
  if (tool?.env && Object.keys(tool.env).length > 0) {
    if (!config.mcpServers) {
      config.mcpServers = { [serverKey]: {} };
    }
    config.mcpServers[serverKey].env = tool.env;
  }
  if (tool?.cwd) {
    config.mcpServers = config.mcpServers || { [serverKey]: {} };
    config.mcpServers[serverKey].cwd = tool.cwd;
  }
  if (tool?.framing) {
    config.mcpServers = config.mcpServers || { [serverKey]: {} };
    config.mcpServers[serverKey].framing = tool.framing;
  }
  return JSON.stringify(config, null, 2);
};
