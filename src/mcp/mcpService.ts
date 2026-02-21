import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { v4 as uuidv4 } from 'uuid';
import i18next from 'i18next';
import { getErrorMessage } from '../utils/errorUtils';
import { debugLog } from '../debug-panel/debugMasterSwitch';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

type TransportType = 'sse' | 'websocket' | 'streamable-http' | 'streamable_http' | 'stdio';

// MCP 规范安全要求：Clients SHOULD validate tool results before passing to LLM
// 清洗工具返回结果，防止过大 payload、控制字符注入、深层嵌套
const MCP_RESULT_MAX_TEXT_LENGTH = 512_000; // 单个 text content 最大 512KB
const MCP_RESULT_MAX_TOTAL_SIZE = 2_000_000; // 总结果最大 2MB
const MCP_RESULT_MAX_DEPTH = 20; // JSON 嵌套最大深度

function sanitizeToolResultContent(content: any): any {
  if (!content) return content;
  if (!Array.isArray(content)) return content;
  let totalSize = 0;
  const result: any[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') { result.push(item); continue; }
    const sanitized = { ...item };
    let itemSize = 0;
    // 清洗 text 类型内容
    if (sanitized.type === 'text' && typeof sanitized.text === 'string') {
      // 移除 NUL 字节和其他不可见控制字符（保留换行、制表符）
      sanitized.text = sanitized.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      // 截断过长文本
      if (sanitized.text.length > MCP_RESULT_MAX_TEXT_LENGTH) {
        sanitized.text = sanitized.text.slice(0, MCP_RESULT_MAX_TEXT_LENGTH) + '\n[...truncated]';
      }
      itemSize = sanitized.text.length;
    }
    // 清洗 image 类型内容（base64 大小限制）
    if (sanitized.type === 'image' && typeof sanitized.data === 'string') {
      itemSize = sanitized.data.length;
    }
    // 清洗 resource 类型嵌入内容
    if (sanitized.type === 'resource' && sanitized.resource) {
      if (typeof sanitized.resource.text === 'string') {
        sanitized.resource = { ...sanitized.resource };
        sanitized.resource.text = sanitized.resource.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        if (sanitized.resource.text.length > MCP_RESULT_MAX_TEXT_LENGTH) {
          sanitized.resource.text = sanitized.resource.text.slice(0, MCP_RESULT_MAX_TEXT_LENGTH) + '\n[...truncated]';
        }
        itemSize = sanitized.resource.text.length;
      }
    }
    // 逐项累计总大小：超限后丢弃后续内容（至少保留第一项）
    totalSize += itemSize;
    if (totalSize > MCP_RESULT_MAX_TOTAL_SIZE && result.length > 0) break;
    result.push(sanitized);
  }
  return result;
}

function clampJsonDepth(obj: any, maxDepth: number, currentDepth = 0): any {
  if (currentDepth >= maxDepth) return typeof obj === 'string' ? obj : '[depth limit]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item: any) => clampJsonDepth(item, maxDepth, currentDepth + 1));
  }
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = clampJsonDepth(v, maxDepth, currentDepth + 1);
  }
  return result;
}

const isWindowsPlatform = () => {
  if (typeof navigator === 'undefined') return false;
  return /windows/i.test(navigator.userAgent);
};

// SECURITY: Restrict default MCP filesystem access to the current user's home
// directory instead of the entire /Users (macOS) or C:\Users (Windows) tree,
// which would expose ALL user home directories on the system.
const DEFAULT_STDIO_ARGS: string[] = [
  '@modelcontextprotocol/server-filesystem',
  isWindowsPlatform() ? 'C:\\Users\\Default' : '/tmp',
];

// Eagerly resolve the real home directory via Tauri path API and patch the
// mutable fallback above. By the time a user actually triggers an MCP stdio
// connection the promise will have settled.
(async () => {
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    if (home) DEFAULT_STDIO_ARGS[1] = home;
  } catch {
    // Non-Tauri environment or API unavailable – safe fallback remains.
  }
})();

const isTauriEnvironment =
  typeof window !== 'undefined'
  && Boolean((window as any).__TAURI_INTERNALS__);

export interface McpServerConfig {
  id: string;
  type: TransportType;
  url?: string;
  headers?: Record<string, string>;
  namespace?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  framing?: 'jsonl' | 'content_length';
}

export interface McpConfig {
  servers: McpServerConfig[];
  cacheTtlMs?: number;
}

export interface McpStatusInfo {
  available: boolean;
  connected: boolean;
  servers: Array<{ id: string; connected: boolean; error?: string }>;
  toolsCount: number;
  lastError?: string;
}

export interface ToolInfo { name: string; description?: string; input_schema?: any }
export interface PromptInfo { name: string; description?: string; arguments?: any }
export interface ResourceInfo { uri: string; name?: string; description?: string; mime_type?: string }

interface ServerRuntime {
  cfg: McpServerConfig;
  client: Client;
  transport?: any; // 保存当前 transport 引用，重连前用于清理旧资源
  connectPromise?: Promise<void>;
  connected: boolean;
  error?: string;
  retryTimer?: any;
  retryAttempts?: number;
  lastEventId?: string;
  keepaliveTimer?: any; // 周期性 ping 定时器
  keepaliveFailCount?: number; // 连续 ping 失败次数，容忍瞬态网络抖动
  reconnectingFromKeepalive?: boolean; // keepalive 主动触发重连时置 true，防止 onclose 双重重连
  serverCapabilities?: ServerCapabilities; // 服务器声明的 capabilities（通过 SDK 公开 API 获取）
}

type Listener = (s: McpStatusInfo) => void;

const BOOTSTRAP_COOLDOWN_MS = 15_000;
let bootstrapInFlight: Promise<void> | null = null;
let lastBootstrapSignature: string | null = null;
let lastBootstrapCompletedAt = 0;

// 调试事件触发辅助函数
const emitMcpDebugEvent = (eventType: string, detail: any) => {
  try {
    if (typeof window !== 'undefined') {
      // 确保 detail 中的所有值都是可序列化的
      const serializedDetail = { ...detail };
      if (serializedDetail.error && typeof serializedDetail.error === 'object') {
        serializedDetail.error = getErrorMessage(serializedDetail.error);
      }
      const event = new CustomEvent(eventType, { detail: serializedDetail });
      window.dispatchEvent(event);
    }
  } catch (e: unknown) {
    // 静默失败，避免影响主逻辑
    debugLog.warn('[MCP] Failed to emit debug event:', e);
  }
};

const isMethodNotFoundError = (error: any): boolean => {
  if (!error) return false;
  const code = (error as any)?.code ?? (error as any)?.error?.code;
  if (typeof code === 'number' && code === -32601) return true;
  const message = String((error as any)?.message ?? (error as any)?.error?.message ?? error ?? '')
    .toLowerCase();
  return message.includes('method not found') || message.includes('-32601');
};

/**
 * 检测是否为认证相关错误 (401/403)
 */
const isAuthError = (error: unknown): boolean => {
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes('401') ||
         msg.includes('403') ||
         msg.includes('unauthorized') ||
         msg.includes('forbidden') ||
         msg.includes('authentication') ||
         msg.includes('invalid api key') ||
         msg.includes('invalid_api_key');
};

/**
 * 检测是否为连接断开/传输层错误（可通过重连恢复）
 * 常见：MCP error -32000: Connection closed / transport closed / ECONNRESET
 */
const isConnectionError = (error: unknown): boolean => {
  if (!error) return false;
  const code = (error as any)?.code ?? (error as any)?.error?.code;
  // -32000 是 JSON-RPC 通用服务器错误，MCP SDK 用它表示连接关闭
  if (typeof code === 'number' && code === -32000) return true;
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes('connection closed') ||
         msg.includes('connection reset') ||
         msg.includes('transport closed') ||
         msg.includes('econnreset') ||
         msg.includes('econnrefused') ||
         msg.includes('socket hang up') ||
         msg.includes('network error') ||
         msg.includes('fetch failed') ||
         msg.includes('aborted');
};

export const isTauriStreamChannelCompatError = (error: unknown): boolean => {
  const msg = getErrorMessage(error).toLowerCase();
  return msg.includes('fetch_read_body') && msg.includes('streamchannel');
};

class McpServiceImpl {
  private cfg: McpConfig = { servers: [], cacheTtlMs: 300_000 };
  private servers: Map<string, ServerRuntime> = new Map();
  // Per-server caches to avoid cross-server pollution
  private toolCacheByServer: Map<string, { at: number; tools: ToolInfo[] }> = new Map();
  private promptCacheByServer: Map<string, { at: number; prompts: PromptInfo[] }> = new Map();
  private resourceCacheByServer: Map<string, { at: number; resources: ResourceInfo[] }> = new Map();
  private listeners = new Set<Listener>();
  // 防止错误状态日志刷屏：记录上一次的错误摘要签名
  private lastErrorSummaryKey: string | null = null;
  // 标记是否正在销毁，防止 dispose() 触发的 onclose 引发重连
  private _disposing = false;
  
  private readonly CACHE_KEY_TOOLS = 'mcp_cache_tools'; // per-server suffix: ::<serverId>
  private readonly CACHE_KEY_PROMPTS = 'mcp_cache_prompts';
  private readonly CACHE_KEY_RESOURCES = 'mcp_cache_resources';
  
  private loadCacheFromStorage() {
    try {
      // Per-server load: iterate over configured servers and load each snapshot
      for (const serverId of this.servers.keys()) {
        const toolsStr = localStorage.getItem(`${this.CACHE_KEY_TOOLS}::${serverId}`);
        if (toolsStr) {
          const data = JSON.parse(toolsStr);
          if (data.at && (Date.now() - data.at) < 24 * 60 * 60 * 1000) {
            this.toolCacheByServer.set(serverId, { at: data.at, tools: Array.isArray(data.tools) ? data.tools : [] });
          }
        }
        const promptsStr = localStorage.getItem(`${this.CACHE_KEY_PROMPTS}::${serverId}`);
        if (promptsStr) {
          const data = JSON.parse(promptsStr);
          if (data.at && (Date.now() - data.at) < 24 * 60 * 60 * 1000) {
            this.promptCacheByServer.set(serverId, { at: data.at, prompts: Array.isArray(data.prompts) ? data.prompts : [] });
          }
        }
        const resourcesStr = localStorage.getItem(`${this.CACHE_KEY_RESOURCES}::${serverId}`);
        if (resourcesStr) {
          const data = JSON.parse(resourcesStr);
          if (data.at && (Date.now() - data.at) < 24 * 60 * 60 * 1000) {
            this.resourceCacheByServer.set(serverId, { at: data.at, resources: Array.isArray(data.resources) ? data.resources : [] });
          }
        }
      }
    } catch (e: unknown) {
      debugLog.warn('Failed to load MCP cache from localStorage:', e);
    }
  }
  
  private saveCacheToStorage() {
    try {
      for (const [serverId, snap] of this.toolCacheByServer.entries()) {
        localStorage.setItem(`${this.CACHE_KEY_TOOLS}::${serverId}`, JSON.stringify(snap));
      }
      for (const [serverId, snap] of this.promptCacheByServer.entries()) {
        localStorage.setItem(`${this.CACHE_KEY_PROMPTS}::${serverId}`, JSON.stringify(snap));
      }
      for (const [serverId, snap] of this.resourceCacheByServer.entries()) {
        localStorage.setItem(`${this.CACHE_KEY_RESOURCES}::${serverId}`, JSON.stringify(snap));
      }
    } catch (e: unknown) {
      debugLog.warn('Failed to save MCP cache to localStorage:', e);
    }
  }

  init(cfg: McpConfig) {
    this.dispose();
    this._disposing = false; // 重置销毁标记，开始新生命周期
    this.cfg = { ...cfg, cacheTtlMs: cfg.cacheTtlMs ?? 300_000 };
    this.toolCacheByServer.clear();
    this.promptCacheByServer.clear();
    this.resourceCacheByServer.clear();
    for (const s of cfg.servers) {
      const client = new Client({ name: 'dstu-frontend-mcp', version: '1.0.0' });
      this.servers.set(s.id, { cfg: s, client, connected: false });
    }
    // 初始化时加载持久化缓存
    this.loadCacheFromStorage();
    // Removed shims - handle in transport config instead
    this.emitStatus();
    
    // 触发配置初始化事件
    emitMcpDebugEvent('mcp-config-init', {
      servers: cfg.servers.map(s => ({ id: s.id, type: s.type, namespace: s.namespace })),
      cacheTtlMs: cfg.cacheTtlMs,
    });
  }

  async connectAll() {
    const tasks: Promise<void>[] = [];
    for (const rt of this.servers.values()) {
      if (!rt.connectPromise) rt.connectPromise = this.connectServer(rt);
      tasks.push(rt.connectPromise);
    }
    await Promise.allSettled(tasks);
    // 不强制刷新缓存：仅在无缓存时或TTL内按需使用（设置页“缓存详情”不应被隐式刷新）
    await Promise.all([
      this.refreshTools(false),
      this.refreshPrompts(false),
      this.refreshResources(false),
    ]);
  }

  private async connectServer(rt: ServerRuntime) {
    // 触发连接开始事件
    emitMcpDebugEvent('mcp-connect-start', {
      serverId: rt.cfg.id,
      transport: rt.cfg.type,
    });

    try {
      // 🔧 业界最佳实践：重连时清理旧 transport 资源 + 创建新 Client 实例
      // 旧 Client/Protocol 内部可能有陈旧状态（pending requests、stale session ID），
      // 复用会导致 listTools() 返回空或挂起。

      // ★ 关键：先清除旧 Client 的回调，防止关闭 transport 时触发 onclose 引发级联重连
      rt.client.onclose = undefined;
      rt.client.onerror = undefined;

      if (rt.transport) {
        try { await rt.transport.close?.(); } catch { /* best-effort cleanup */ }
        rt.transport = undefined;
      }
      if (rt.keepaliveTimer) {
        clearInterval(rt.keepaliveTimer);
        rt.keepaliveTimer = undefined;
      }
      // 每次连接都创建新 Client，确保 Protocol 状态干净
      // MCP SDK v2: 启用 listChanged autoRefresh，当服务器发送 notifications/tools/list_changed 等通知时自动刷新
      const self = this;
      const serverId = rt.cfg.id;
      rt.client = new Client(
        { name: 'dstu-frontend-mcp', version: '1.0.0' },
        {
          capabilities: {
            roots: { listChanged: true },
            sampling: {},
          },
          listChanged: {
            tools: {
              autoRefresh: true,
              debounceMs: 200,
              onChanged: (error: any, tools: any) => {
                if (error) { console.warn(`[MCP] listChanged tools refresh error for ${serverId}:`, error); }
                if (tools && Array.isArray(tools)) {
                  const toolsForServer: ToolInfo[] = tools.map((t: any) => ({
                    name: self.withNamespace(t.name, rt.cfg.namespace),
                    description: t.description || '',
                    input_schema: t.inputSchema,
                  }));
                  self.toolCacheByServer.set(serverId, { at: Date.now(), tools: toolsForServer });
                  self.saveCacheToStorage();
                  self.emitStatus();
                }
              },
            },
            prompts: {
              autoRefresh: true,
              debounceMs: 200,
              onChanged: (error: any, prompts: any) => {
                if (error) { console.warn(`[MCP] listChanged prompts refresh error for ${serverId}:`, error); }
                if (prompts && Array.isArray(prompts)) {
                  const promptsForServer: PromptInfo[] = prompts.map((p: any) => ({
                    name: self.withNamespace(p.name, rt.cfg.namespace),
                    description: p.description || '',
                    arguments: p.arguments,
                  }));
                  self.promptCacheByServer.set(serverId, { at: Date.now(), prompts: promptsForServer });
                  self.saveCacheToStorage();
                  self.emitStatus();
                }
              },
            },
            resources: {
              autoRefresh: true,
              debounceMs: 200,
              onChanged: (error: any, resources: any) => {
                if (error) { console.warn(`[MCP] listChanged resources refresh error for ${serverId}:`, error); }
                if (resources && Array.isArray(resources)) {
                  const resourcesForServer: ResourceInfo[] = resources.map((r: any) => ({
                    uri: r.uri || r.id || '',
                    name: r.name ? self.withNamespace(r.name, rt.cfg.namespace) : undefined,
                    description: r.description,
                    mime_type: r.mimeType || r.mime_type,
                  }));
                  self.resourceCacheByServer.set(serverId, { at: Date.now(), resources: resourcesForServer });
                  self.saveCacheToStorage();
                  self.emitStatus();
                }
              },
            },
          },
        },
      );

      const { cfg, client } = rt;
      const headers = cfg.headers ?? {};
      // Map remote URLs via local dev proxy to bypass CORS
      const mapUrl = (raw: string) => {
        try {
          const u = new URL(raw);
          // 避免在日志中泄露敏感查询参数
          const redact = (urlStr: string) => {
            try { const uu = new URL(urlStr); uu.search = ''; return uu.toString(); } catch { return urlStr; }
          };
          
          // Auto-fix transport-specific path issues (静默修复，不打印日志)
          if (cfg.type === 'sse') {
            // SSE should have /sse suffix
            if (u.pathname.endsWith('/mcp')) {
              u.pathname = u.pathname.replace(/\/mcp$/, '/sse');
            } else if (!u.pathname.endsWith('/sse') && u.pathname.match(/\/[a-f0-9]{10,}$/)) {
              u.pathname = u.pathname + '/sse';
            }
          } else if (cfg.type === 'streamable-http' || cfg.type === 'streamable_http') {
            // Streamable HTTP uses /mcp endpoint
            if (!u.pathname.endsWith('/mcp')) {
              if (u.pathname.endsWith('/sse')) {
                u.pathname = u.pathname.replace(/\/sse$/, '/mcp');
              } else if (u.pathname.match(/\/[a-f0-9]{10,}$/)) {
                u.pathname = u.pathname + '/mcp';
              }
            }
          } else if (cfg.type === 'websocket') {
            // WebSocket might use /ws suffix
            if (u.pathname.endsWith('/sse')) {
              u.pathname = u.pathname.replace(/\/sse$/, '/ws');
            }
          }
          
          // Some providers accept api_key via query — attach from headers if missing
          if ((u.hostname.endsWith('modelscope.net') || u.hostname.includes('api-inference')) && !u.searchParams.has('api_key')) {
            const key = headers['X-API-Key'] || (headers['Authorization']?.replace(/^Bearer\s+/i, ''));
            if (key) u.searchParams.set('api_key', key);
          }
          
          // In dev mode (non-Tauri), use proxy for ModelScope and other remote providers
          // 注意：Tauri 环境下不需要代理，因为 Tauri HTTP 插件可以直接访问远程 URL
          const inTauriEnv = typeof window !== 'undefined' &&
            Boolean((window as any).__TAURI_INTERNALS__);
          if (import.meta.env?.DEV && !inTauriEnv && (u.hostname === 'mcp.api-inference.modelscope.net' || u.hostname.includes('modelscope'))) {
            const transportType = cfg.type;
            
            if (transportType === 'streamable_http' || transportType === 'streamable-http') {
              return new URL('/http-proxy' + u.pathname + u.search, window.location.origin).toString();
            } else if (transportType === 'sse') {
              return new URL('/sse-proxy' + u.pathname + u.search, window.location.origin).toString();
            } else if (transportType === 'websocket') {
              const wsUrl = new URL('/ws-proxy' + u.pathname + u.search, window.location.origin);
              wsUrl.protocol = 'ws:';
              return wsUrl.toString();
            } else {
              return new URL('/http-proxy' + u.pathname + u.search, window.location.origin).toString();
            }
          }
          return u.toString();
        } catch { return raw; }
      };

      let transport;
      const mappedUrl = cfg.url ? mapUrl(cfg.url) : undefined;

      // 在 Tauri 环境中使用 Tauri HTTP 插件的 fetch，绕过 CORS 限制
      // 注意：前后端 tauri-plugin-http 版本必须一致，否则会出现 streamChannel 兼容错误
      let customFetch: typeof fetch | undefined;
      const shouldUseTauriFetch = isTauriEnvironment || (
        typeof window !== 'undefined' &&
        Boolean((window as any).__TAURI_INTERNALS__)
      );

      if (shouldUseTauriFetch) {
        try {
          const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
          customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            try {
              return await (tauriFetch as typeof fetch)(input, init);
            } catch (error: unknown) {
              if (isTauriStreamChannelCompatError(error)) {
                debugLog.warn('[MCP] Tauri HTTP streamChannel compatibility issue detected, falling back to browser fetch');
                return await fetch(input, init);
              }
              throw error;
            }
          }) as typeof fetch;
        } catch {
          // Tauri HTTP 插件不可用，静默回退到浏览器 fetch
        }
      }

      switch (cfg.type) {
        case 'websocket':
          if (!mappedUrl) throw new Error(i18next.t('mcp:service.missing_websocket_url'));
          // Note: WebSocketClientTransport only accepts URL, headers not supported by SDK
          transport = new WebSocketClientTransport(new URL(mappedUrl));
          break;
        case 'streamable-http':
        case 'streamable_http':
          if (!mappedUrl) throw new Error(i18next.t('mcp:service.missing_streamable_http_url'));
          transport = new StreamableHTTPClientTransport(new URL(mappedUrl), {
            requestInit: { headers },
            ...(customFetch ? { fetch: customFetch } : {}),
          });
          break;
    case 'sse': {
      if (!mappedUrl) throw new Error(i18next.t('mcp:service.missing_sse_url'));
      const requestHeaders: Record<string, string> = { ...headers };
      if (rt.lastEventId && String(rt.lastEventId).trim().length > 0) {
        requestHeaders['Last-Event-ID'] = String(rt.lastEventId);
      }
      // SSE 需要同时设置 eventSourceInit.fetch 和 fetch
      // eventSourceInit.fetch 用于 SSE 连接，fetch 用于 POST 消息
      transport = new SSEClientTransport(new URL(mappedUrl), {
        requestInit: Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : undefined,
        ...(customFetch ? {
          fetch: customFetch,
          eventSourceInit: { fetch: customFetch }
        } : {}),
      });
      break;
    }
        case 'stdio': {
          const { isTauriStdioSupported, TauriStdioClientTransport } = await import('./tauriStdioTransport');
          if (!isTauriStdioSupported()) {
            throw new Error(i18next.t('mcp:service.stdio_desktop_only'));
          }
          if (!cfg.command || !cfg.command.trim()) {
            throw new Error(i18next.t('mcp:service.stdio_missing_command'));
          }
          transport = new TauriStdioClientTransport({
            command: cfg.command,
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env || {},
            cwd: cfg.cwd,
            framing: cfg.framing ?? 'content_length',
          }, cfg.id); // 传入 serverId 用于调试
          break;
        }
        default:
          throw new Error(i18next.t('mcp:service.unsupported_transport_type', { type: cfg.type }));
      }

      await client.connect(transport);
      // 保存 transport 引用，重连时用于清理旧资源
      rt.transport = transport;
      // 通过 SDK 公开 API 获取服务器 capabilities
      rt.serverCapabilities = client.getServerCapabilities();
      if (cfg.type === 'sse') {
        const sseTransport = transport as SSEClientTransport;
        const eventSource: any = (sseTransport as any)?._eventSource;
        if (eventSource && typeof eventSource.addEventListener === 'function') {
          eventSource.addEventListener('message', (event: any) => {
            const lastEventId = event?.lastEventId;
            if (lastEventId && String(lastEventId).trim().length > 0) {
              rt.lastEventId = String(lastEventId);
            }
          });
        }
      }
      rt.connected = true;
      rt.error = undefined;
      // Reset backoff on success
      if (rt.retryTimer) { clearTimeout(rt.retryTimer); rt.retryTimer = undefined; }
      rt.retryAttempts = 0;
      
      // 触发连接成功事件
      emitMcpDebugEvent('mcp-connect-success', {
        serverId: cfg.id,
        transport: cfg.type,
      });

      // 🔧 业界最佳实践：周期性 keepalive ping 检测半开连接
      // SDK 的 onclose 只能检测传输层断开，无法检测服务器已终止会话但 TCP 仍存活的情况
      // 注意：必须容忍瞬态网络抖动，连续多次失败后才判定连接已死
      const KEEPALIVE_INTERVAL_MS = 90_000; // 90秒（远程服务器需要更长间隔）
      const KEEPALIVE_MAX_FAILURES = 3; // 连续3次失败才触发重连
      rt.keepaliveFailCount = 0;
      rt.keepaliveTimer = setInterval(async () => {
        if (!rt.connected || this._disposing) {
          if (rt.keepaliveTimer) { clearInterval(rt.keepaliveTimer); rt.keepaliveTimer = undefined; }
          return;
        }
        try {
          await rt.client.request({ method: 'ping' }, {} as any);
          // ping 成功，重置失败计数
          rt.keepaliveFailCount = 0;
        } catch (pingErr: unknown) {
          // Method not found (-32601) 表示服务器不支持 ping 但连接仍然正常
          if (isMethodNotFoundError(pingErr)) {
            rt.keepaliveFailCount = 0;
            return;
          }
          rt.keepaliveFailCount = (rt.keepaliveFailCount || 0) + 1;
          if (rt.keepaliveFailCount < KEEPALIVE_MAX_FAILURES) {
            debugLog.warn(`[MCP] Keepalive ping failed for ${cfg.id} (${rt.keepaliveFailCount}/${KEEPALIVE_MAX_FAILURES}), will retry`);
            return; // 还没到阈值，等下一次再检查
          }
          debugLog.warn(`[MCP] Keepalive ping failed ${KEEPALIVE_MAX_FAILURES} times for ${cfg.id}, triggering reconnect`);
          rt.keepaliveFailCount = 0;
          // 设置标志位，防止 onclose 回调再次触发重连（避免双重重连）
          rt.reconnectingFromKeepalive = true;
          // 连续失败达到阈值，判定连接已死，主动触发 close 后直接重连
          try { await rt.client.close(); } catch { /* ignore */ }
          // keepalive 自行发起重连
          rt.connected = false;
          rt.connectPromise = undefined;
          this.emitStatus();
          rt.connectPromise = this.connectServer(rt).catch((err) => {
            debugLog.error('[MCP] Reconnect from keepalive failed:', err);
          }).finally(() => {
            rt.reconnectingFromKeepalive = false;
          });
        }
      }, KEEPALIVE_INTERVAL_MS);

      // ── 被动断开检测 ──────────────────────────────────────────────
      // MCP SDK 的 Protocol.connect() 会接管 transport 的回调，
      // 因此在 client（Protocol 子类）上注册 onclose/onerror 即可
      // 覆盖所有传输类型（SSE / WebSocket / StreamableHTTP / stdio）。

      client.onclose = () => {
        // dispose() 主动关闭时不触发重连
        if (this._disposing) return;

        // keepalive 主动触发的 close：重连已由 keepalive 处理，此处仅做清理
        if (rt.reconnectingFromKeepalive) {
          if (rt.keepaliveTimer) { clearInterval(rt.keepaliveTimer); rt.keepaliveTimer = undefined; }
          return;
        }

        // 清理 keepalive 定时器
        if (rt.keepaliveTimer) { clearInterval(rt.keepaliveTimer); rt.keepaliveTimer = undefined; }

        const wasConnected = rt.connected;
        rt.connected = false;
        rt.connectPromise = undefined;
        rt.error = i18next.t('mcp:service.connection_lost');

        if (wasConnected) {
          debugLog.warn(`[MCP] Passive disconnect detected for ${cfg.id} (${cfg.type})`);
          emitMcpDebugEvent('mcp-passive-disconnect', {
            serverId: cfg.id,
            transport: cfg.type,
          });
        }
        this.emitStatus();

        // 使用指数退避自动重连
        const MAX_RECONNECT_ATTEMPTS = 5;
        const attempts = rt.retryAttempts || 0;
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          debugLog.warn('[MCP] Max reconnect attempts reached after passive disconnect:', {
            id: cfg.id,
            attempts,
          });
          return;
        }
        // 首次重连快速恢复(500ms)，后续指数退避
        const delay = attempts === 0 ? 500 : Math.min(60_000, 2_000 * Math.pow(2, attempts - 1));
        rt.retryAttempts = attempts + 1;
        if (rt.retryTimer) clearTimeout(rt.retryTimer);
        rt.retryTimer = setTimeout(() => {
          rt.connectPromise = undefined;
          this.connectServer(rt).catch((err) => {
            debugLog.error('[MCP] Reconnect after passive disconnect failed:', err);
          });
        }, delay);

        emitMcpDebugEvent('mcp-reconnect-scheduled', {
          serverId: cfg.id,
          transport: cfg.type,
          attempt: attempts + 1,
          delay,
        });
      };

      client.onerror = (error: Error) => {
        // dispose() 期间忽略错误
        if (this._disposing) return;

        debugLog.warn(`[MCP] Transport error for ${cfg.id} (${cfg.type}):`, {
          error: getErrorMessage(error),
        });
        emitMcpDebugEvent('mcp-transport-error', {
          serverId: cfg.id,
          transport: cfg.type,
          error: getErrorMessage(error),
        });
        // 注意：onerror 不一定是致命的（SDK 文档说明），
        // 真正断开时 onclose 会被调用，因此这里只记录不触发重连。
      };
    } catch (e: any) {
      rt.connected = false;
      const rawError = getErrorMessage(e);
      
      // 检测认证错误 (401/403)
      const authFailed = isAuthError(e);
      if (authFailed) {
        rt.error = i18next.t('mcp:service.auth_failed', { error: rawError });
        
        debugLog.warn(`[MCP] Authentication failed for ${rt.cfg.id}:`, {
          error: rawError,
          hint: 'Check API key or token configuration',
        });
        
        // 触发认证失败专用事件
        emitMcpDebugEvent('mcp-connect-auth-failed', {
          serverId: rt.cfg.id,
          transport: rt.cfg.type,
          error: rt.error,
        });
        
        // 认证错误不重试，更新状态后返回
        this.emitStatus();
        return;
      }
      
      rt.error = rawError;
      
      // 仅在首次失败时输出完整日志，重试失败时静默处理
      const isFirstAttempt = (rt.retryAttempts || 0) === 0;
      if (isFirstAttempt) {
        debugLog.warn(`[MCP] Connection failed for ${rt.cfg.id} (${rt.cfg.type}):`, {
          error: rt.error,
        });
        
        // 触发连接失败事件
        emitMcpDebugEvent('mcp-connect-fail', {
          serverId: rt.cfg.id,
          transport: rt.cfg.type,
          error: rt.error,
        });
      }
      
      // 针对明显不可恢复的错误（如 404 Not Found 的无效会话 ID），不再重试，避免控制台刷屏
      try {
        const msg = String(e?.message || e || '').toLowerCase();
        const isNotFound = msg.includes('404') || msg.includes('not found');
        const isGone410 = msg.includes('410') || msg.includes('gone');
        const transport = String(rt.cfg.type || '').toLowerCase();
        const shouldRetry = isGone410 || (!isNotFound && transport !== 'stdio');
        
        const MAX_RETRY_ATTEMPTS = 5; // 最大重试次数
        if (shouldRetry) {
          const attempts = (rt.retryAttempts || 0);
          // 超过最大重试次数后停止重试
          if (attempts >= MAX_RETRY_ATTEMPTS) {
            debugLog.warn('[MCP] Max retry attempts reached, stopping reconnection:', {
              id: rt.cfg.id,
              transport: rt.cfg.type,
              attempts,
              error: rt.error,
            });
            emitMcpDebugEvent('mcp-connect-failed', {
              serverId: rt.cfg.id,
              transport: rt.cfg.type,
              error: rt.error,
              attempts,
            });
          } else {
            // 首次重连快速恢复(500ms)，后续指数退避
            const delay = attempts === 0 ? 500 : Math.min(60_000, 2_000 * Math.pow(2, attempts - 1));
            rt.retryAttempts = attempts + 1;
            if (rt.retryTimer) clearTimeout(rt.retryTimer);
            rt.retryTimer = setTimeout(() => {
              rt.connectPromise = undefined; // allow new attempt
              this.connectServer(rt).catch((err) => { debugLog.error('[MCP] Retry connection failed:', err); });
            }, delay);

            // 仅触发重试事件，不再打印日志（避免控制台刷屏）
            emitMcpDebugEvent('mcp-connect-retry', {
              serverId: rt.cfg.id,
              transport: rt.cfg.type,
              attempt: attempts + 1,
              delay,
            });
          }
        } else {
          // 不重试：保留错误状态并提示
          debugLog.warn('[MCP] Not retrying connection due to non-retryable error:', {
            id: rt.cfg.id,
            transport: rt.cfg.type,
            error: rt.error,
          });
        }
      } catch (retryErr: unknown) {
        console.warn('[MCP] Error while scheduling retry logic:', retryErr);
      }
    } finally {
      this.emitStatus();
    }
  }


  onStatus(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emitStatus() {
    const servers = Array.from(this.servers.values()).map(rt => {
      // 调试：确保 error 一定是字符串
      if (rt.error && typeof rt.error !== 'string') {
        debugLog.warn(`[MCP] rt.error is not string for ${rt.cfg.id}:`, {
          error: rt.error,
          type: typeof rt.error,
          constructor: (rt.error as any)?.constructor?.name
        });
        rt.error = String(rt.error);
      }
      // 返回 namespace（去掉末尾冒号）作为显示名称
      const namespace = rt.cfg.namespace?.replace(/:$/, '') || '';
      return { id: rt.cfg.id, connected: rt.connected, error: rt.error, namespace };
    });
    const status: McpStatusInfo = {
      available: this.servers.size > 0,
      connected: servers.some(s => s.connected),
      servers,
      toolsCount: Array.from(this.toolCacheByServer.values()).reduce((acc, s) => acc + (s.tools?.length || 0), 0),
      lastError: servers.find(s => s.error)?.error,
    };
    
    // 调试：打印状态（仅在错误摘要变化时打印，避免刷屏）
    try {
      const errorSummary = servers
        .filter(s => !!s.error)
        .map(s => ({ id: s.id, err: String(s.error || '') }))
        .sort((a, b) => a.id.localeCompare(b.id));
      // 仅在错误发生变化时更新状态 key（不再打印日志避免控制台刷屏）
      const summaryKey = errorSummary.length > 0 ? JSON.stringify(errorSummary) : '';
      if (summaryKey !== this.lastErrorSummaryKey) {
        this.lastErrorSummaryKey = summaryKey;
      }
    } catch {
      // Non-critical: error summary serialization failed; ignore to avoid breaking status emission
    }
    
    for (const l of this.listeners) { try { l(status); } catch (e: unknown) { console.warn('[MCP] Status listener callback threw:', e); } }
  }

  async status(): Promise<McpStatusInfo> {
    return new Promise(resolve => {
      const off = this.onStatus(s => { off(); resolve(s); });
      this.emitStatus();
    });
  }

  private getServer(id: string): ServerRuntime | undefined { return this.servers.get(id); }
  async connectServerById(id: string) {
    const rt = this.getServer(id);
    if (!rt) throw new Error(i18next.t('mcp:service.server_not_found', { id }));
    if (rt.connected) return;
    if (!rt.connectPromise) rt.connectPromise = this.connectServer(rt);
    await rt.connectPromise;
  }

  private withNamespace(name: string, ns?: string) {
    return ns ? `${ns}${name}` : name;
  }

  async refreshTools(force = false): Promise<ToolInfo[]> {
    const now = Date.now();
    const ttl = this.cfg.cacheTtlMs || 0;
    const aggregated: ToolInfo[] = [];
    for (const rt of this.servers.values()) {
      const sid = rt.cfg.id;
      const cache = this.toolCacheByServer.get(sid);
      const notExpired = cache && (now - cache.at) < ttl;
      if (!force && notExpired) {
        aggregated.push(...(cache?.tools || []));
        continue;
      }
      if (!rt.connected) {
        // 断开时保留旧缓存（与 refreshPrompts/refreshResources 行为一致）
        if (cache && cache.tools?.length) aggregated.push(...cache.tools);
        continue;
      }
      // 行业标准：不做 capabilities 预检，直接尝试 listTools()，
      // 依赖 -32601 错误处理作为真正的 fallback（官方 SDK 示例模式）
      try {
        // MCP 规范：支持 pagination cursor，循环获取所有页（安全上限 100 页防止异常服务器死循环）
        const allTools: any[] = [];
        let cursor: string | undefined;
        let pageCount = 0;
        do {
          const list = await rt.client.listTools(cursor ? { cursor } : undefined);
          if (list.tools) allTools.push(...list.tools);
          cursor = (list as any).nextCursor;
          if (++pageCount >= 100) { cursor = undefined; break; }
        } while (cursor);
        const toolsForServer: ToolInfo[] = allTools.map((t: any) => ({
          name: this.withNamespace(t.name, rt.cfg.namespace),
          description: t.description || '',
          input_schema: t.inputSchema,
        }));
        this.toolCacheByServer.set(sid, { at: now, tools: toolsForServer });
        aggregated.push(...toolsForServer);
      } catch (e: unknown) {
        if (isMethodNotFoundError(e)) {
          // 服务器不支持 tools/list 方法，设置空列表但保留提示
          debugLog.warn(`[MCP] Server ${sid} does not support tools/list method`);
          this.toolCacheByServer.set(sid, { at: now, tools: [] });
          rt.error = undefined;
        } else {
          // 其他错误（网络超时、资源失效等）：保留旧缓存而非清空
          debugLog.warn(`[MCP] listTools failed for ${sid}:`, getErrorMessage(e));
          const existingCache = this.toolCacheByServer.get(sid);
          if (existingCache && existingCache.tools.length > 0) {
            // 保留旧的有效缓存，仅更新时间戳避免频繁重试
            aggregated.push(...existingCache.tools);
          }
          rt.error = getErrorMessage(e);
          this.emitStatus();
        }
      }
    }
    this.saveCacheToStorage();
    this.emitStatus();
    return aggregated;
  }

  async listTools(): Promise<ToolInfo[]> {
    // Return aggregated tools from per-server caches; refresh if empty
    const now = Date.now();
    const ttl = this.cfg.cacheTtlMs || 0;
    const anyValid = Array.from(this.toolCacheByServer.values()).some(s => (now - s.at) < ttl && (s.tools?.length || 0) > 0);
    if (!anyValid) {
      return this.refreshTools(false);
    }
    const arr: ToolInfo[] = [];
    for (const snap of this.toolCacheByServer.values()) { arr.push(...(snap.tools || [])); }
    return arr;
  }

  // Per-server fetch helpers (no cache), useful for Settings quick inspection
  async fetchServerTools(serverId: string): Promise<ToolInfo[]> {
    const rt = this.getServer(serverId);
    if (!rt) return [];
    await this.connectServerById(serverId).catch((err) => { debugLog.error('[MCP] connectServerById failed for tools fetch:', err); });
    if (!rt.connected) return [];
    try {
      const allTools: any[] = [];
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        const list = await rt.client.listTools(cursor ? { cursor } : undefined);
        if (list.tools) allTools.push(...list.tools);
        cursor = (list as any).nextCursor;
        if (++pageCount >= 100) { cursor = undefined; break; }
      } while (cursor);
      const now = Date.now();
      const tools = allTools.map((t: any) => ({ name: this.withNamespace(t.name, rt.cfg.namespace), description: t.description || '', input_schema: t.inputSchema }));
      this.toolCacheByServer.set(serverId, { at: now, tools });
      this.saveCacheToStorage();
      this.emitStatus();
      return tools;
    } catch (e: unknown) {
      console.warn(`[MCP] fetchServerTools failed for ${serverId}:`, e);
      return [];
    }
  }

  getCachedToolsFor(serverId: string): ToolInfo[] {
    return this.toolCacheByServer.get(serverId)?.tools || [];
  }

  getCachedToolsSnapshot(): Record<string, { at: number; tools: ToolInfo[] }> {
    const out: Record<string, { at: number; tools: ToolInfo[] }> = {};
    for (const [sid, snap] of this.toolCacheByServer.entries()) {
      out[sid] = {
        at: snap.at,
        tools: (snap.tools || []).map(t => ({ ...t })),
      };
    }
    return out;
  }

  getCachedPromptsSnapshot(): Record<string, { at: number; prompts: PromptInfo[] }> {
    const out: Record<string, { at: number; prompts: PromptInfo[] }> = {};
    for (const [sid, snap] of this.promptCacheByServer.entries()) {
      out[sid] = {
        at: snap.at,
        prompts: (snap.prompts || []).map(p => ({ ...p })),
      };
    }
    return out;
  }

  getCachedResourcesSnapshot(): Record<string, { at: number; resources: ResourceInfo[] }> {
    const out: Record<string, { at: number; resources: ResourceInfo[] }> = {};
    for (const [sid, snap] of this.resourceCacheByServer.entries()) {
      out[sid] = {
        at: snap.at,
        resources: (snap.resources || []).map(r => ({ ...r })),
      };
    }
    return out;
  }

  clearCaches() {
    this.toolCacheByServer.clear();
    this.promptCacheByServer.clear();
    this.resourceCacheByServer.clear();
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith('mcp_cache_')) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
    } catch (e: unknown) {
      console.warn('[MCP] Failed to clear MCP cache keys from localStorage:', e);
    }
    this.emitStatus();
  }

  async fetchServerPrompts(serverId: string): Promise<PromptInfo[]> {
    const rt = this.getServer(serverId);
    if (!rt) return [];
    await this.connectServerById(serverId).catch((err) => { debugLog.error('[MCP] connectServerById failed for prompts fetch:', err); });
    if (!rt.connected) return [];
    try {
      const allPrompts: any[] = [];
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        const resp = await rt.client.listPrompts(cursor ? { cursor } : undefined);
        if (resp?.prompts) allPrompts.push(...resp.prompts);
        cursor = (resp as any)?.nextCursor;
        if (++pageCount >= 100) { cursor = undefined; break; }
      } while (cursor);
      return allPrompts.map((p: any) => ({ name: this.withNamespace(p.name, rt.cfg.namespace), description: p.description || '', arguments: p.arguments }));
    } catch (e: unknown) {
      console.warn(`[MCP] fetchServerPrompts failed for ${serverId}:`, e);
      return [];
    }
  }

  async fetchServerResources(serverId: string): Promise<ResourceInfo[]> {
    const rt = this.getServer(serverId);
    if (!rt) return [];
    await this.connectServerById(serverId).catch((err) => { debugLog.error('[MCP] connectServerById failed for resources fetch:', err); });
    if (!rt.connected) return [];
    try {
      const allResources: any[] = [];
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        const resp = await rt.client.listResources(cursor ? { cursor } : undefined);
        if (resp?.resources) allResources.push(...resp.resources);
        cursor = (resp as any)?.nextCursor;
        if (++pageCount >= 100) { cursor = undefined; break; }
      } while (cursor);
      return allResources.map((r: any) => {
        const baseName = r.name || '';
        return {
          uri: r.uri || r.id || '',
          name: baseName ? this.withNamespace(baseName, rt.cfg.namespace) : undefined,
          description: r.description,
          mime_type: r.mimeType || r.mime_type
        };
      });
    } catch (e: unknown) {
      console.warn(`[MCP] fetchServerResources failed for ${serverId}:`, e);
      return [];
    }
  }

  async refreshPrompts(force = false): Promise<PromptInfo[]> {
    const now = Date.now();
    const ttl = this.cfg.cacheTtlMs || 0;
    const aggregated: PromptInfo[] = [];
    for (const rt of this.servers.values()) {
      const sid = rt.cfg.id;
      const cache = this.promptCacheByServer.get(sid);
      const notExpired = cache && (now - cache.at) < ttl;
      if (!force && notExpired) {
        aggregated.push(...(cache?.prompts || []));
        continue;
      }
      if (!rt.connected) {
        if (cache && cache.prompts?.length) aggregated.push(...cache.prompts);
        continue;
      }
      try {
        // MCP 规范：支持 pagination cursor（安全上限 100 页）
        const allPrompts: any[] = [];
        let cursor: string | undefined;
        let pageCount = 0;
        do {
          const resp = await rt.client.listPrompts(cursor ? { cursor } : undefined);
          if (resp?.prompts) allPrompts.push(...resp.prompts);
          cursor = (resp as any)?.nextCursor;
          if (++pageCount >= 100) { cursor = undefined; break; }
        } while (cursor);
        const promptsForServer: PromptInfo[] = allPrompts.map((p: any) => ({
          name: this.withNamespace(p.name, rt.cfg.namespace),
          description: p.description || '',
          arguments: p.arguments,
        }));
        this.promptCacheByServer.set(sid, { at: now, prompts: promptsForServer });
        aggregated.push(...promptsForServer);
      } catch (e: unknown) {
        if (isMethodNotFoundError(e)) {
          this.promptCacheByServer.set(sid, { at: now, prompts: [] });
          rt.error = undefined;
        } else {
          rt.error = getErrorMessage(e);
          this.emitStatus();
        }
      }
    }
    this.saveCacheToStorage();
    this.emitStatus();
    return aggregated;
  }

  async listPrompts(): Promise<PromptInfo[]> {
    const now = Date.now();
    const ttl = this.cfg.cacheTtlMs || 0;
    const anyValid = Array.from(this.promptCacheByServer.values()).some(s => (now - s.at) < ttl && (s.prompts?.length || 0) > 0);
    if (!anyValid) {
      return this.refreshPrompts(false);
    }
    const arr: PromptInfo[] = [];
    for (const snap of this.promptCacheByServer.values()) { arr.push(...(snap.prompts || [])); }
    return arr;
  }

  async refreshResources(force = false): Promise<ResourceInfo[]> {
    const now = Date.now();
    const ttl = this.cfg.cacheTtlMs || 0;
    const aggregated: ResourceInfo[] = [];
    for (const rt of this.servers.values()) {
      const sid = rt.cfg.id;
      const cache = this.resourceCacheByServer.get(sid);
      const notExpired = cache && (now - cache.at) < ttl;
      if (!force && notExpired) {
        aggregated.push(...(cache?.resources || []));
        continue;
      }
      if (!rt.connected) {
        if (cache && cache.resources?.length) aggregated.push(...cache.resources);
        continue;
      }
      try {
        // MCP 规范：支持 pagination cursor（安全上限 100 页）
        const allResources: any[] = [];
        let cursor: string | undefined;
        let pageCount = 0;
        do {
          const resp = await rt.client.listResources(cursor ? { cursor } : undefined);
          if (resp?.resources) allResources.push(...resp.resources);
          cursor = (resp as any)?.nextCursor;
          if (++pageCount >= 100) { cursor = undefined; break; }
        } while (cursor);
        const resourcesForServer: ResourceInfo[] = allResources.map((r: any) => {
          const baseName = r.name || '';
          return {
            uri: r.uri || r.id || '',
            name: baseName ? this.withNamespace(baseName, rt.cfg.namespace) : undefined,
            description: r.description,
            mime_type: r.mimeType || r.mime_type,
          };
        });
        this.resourceCacheByServer.set(sid, { at: now, resources: resourcesForServer });
        aggregated.push(...resourcesForServer);
      } catch (e: unknown) {
        if (isMethodNotFoundError(e)) {
          this.resourceCacheByServer.set(sid, { at: now, resources: [] });
          rt.error = undefined;
        } else {
          rt.error = getErrorMessage(e);
          this.emitStatus();
        }
      }
    }
    this.saveCacheToStorage();
    this.emitStatus();
    return aggregated;
  }

  async listResources(): Promise<ResourceInfo[]> {
    const now = Date.now();
    const ttl = this.cfg.cacheTtlMs || 0;
    const anyValid = Array.from(this.resourceCacheByServer.values()).some(s => (now - s.at) < ttl && (s.resources?.length || 0) > 0);
    if (!anyValid) {
      return this.refreshResources(false);
    }
    const arr: ResourceInfo[] = [];
    for (const snap of this.resourceCacheByServer.values()) { arr.push(...(snap.resources || [])); }
    return arr;
  }

  async readResource(uri: string): Promise<{ mime_type?: string; text?: string; base64?: string }> {
    for (const rt of this.servers.values()) {
      if (!rt.connected) continue;
      try {
        if (typeof (rt.client as any).readResource === 'function') {
          const res = await (rt.client as any).readResource(uri);
          return { mime_type: res?.mimeType || res?.mime_type, text: res?.text, base64: res?.base64 }; 
        }
      } catch {
        // try next server
      }
    }
    throw new Error(i18next.t('mcp:service.resource_not_found', { uri }));
  }

  /**
   * 确保服务器已连接，未连接时尝试快速重连（最多等待 reconnectTimeoutMs）
   */
  private async ensureConnected(rt: ServerRuntime, reconnectTimeoutMs = 8000): Promise<boolean> {
    if (rt.connected) return true;
    // 如果已有正在进行的连接尝试，等待它完成
    if (rt.connectPromise) {
      try {
        await Promise.race([
          rt.connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect timeout')), reconnectTimeoutMs)),
        ]);
        return rt.connected;
      } catch {
        return false;
      }
    }
    // 主动发起快速重连
    debugLog.log(`[MCP] ensureConnected: server ${rt.cfg.id} not connected, attempting reconnect`);
    try {
      rt.connectPromise = this.connectServer(rt);
      await Promise.race([
        rt.connectPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect timeout')), reconnectTimeoutMs)),
      ]);
      return rt.connected;
    } catch {
      return false;
    }
  }

  /**
   * 统一工具调用。toolName 可带 namespace；会自动路由到对应 server。
   * 连接断开时会自动重连并重试一次。
   */
  async callTool(toolName: string, args?: any, timeoutMs = 15000): Promise<{
    ok: boolean; data?: any; error?: string; usage?: any;
  }> {
    const started = Date.now();
    const rt = this.pickServerByTool(toolName);
    if (!rt) return { ok: false, error: i18next.t('mcp:service.tool_not_found', { toolName }) };
    
    // 参数验证：根据工具的 JSON Schema 检查参数
    const toolSchema = this.findToolSchema(toolName, rt.cfg.id);
    if (toolSchema) {
      const validationError = this.validateToolArgs(toolSchema, args ?? {});
      if (validationError) {
        emitMcpDebugEvent('mcp-tool-call-validation-error', {
          serverId: rt.cfg.id,
          toolName,
          args,
          error: validationError,
        });
        return { ok: false, error: validationError };
      }
    }

    // 连接预检：未连接时先尝试重连
    if (!rt.connected) {
      const reconnected = await this.ensureConnected(rt);
      if (!reconnected) {
        return { ok: false, error: i18next.t('mcp:service.connection_lost') + ` (server: ${rt.cfg.id})` };
      }
    }

    const rawName = rt.cfg.namespace ? toolName.slice(rt.cfg.namespace.length) : toolName;
    const callId = uuidv4();
    
    // 触发工具调用开始事件
    emitMcpDebugEvent('mcp-tool-call-start', {
      serverId: rt.cfg.id,
      toolName,
      args,
      callId,
    });

    // MCP 规范要求：超时或取消时客户端 SHOULD 发送 notifications/cancelled
    // SDK v1.17+ 内部已在 AbortSignal 触发时自动发送 notifications/cancelled（使用正确的 JSON-RPC request ID），
    // 无需手动发送（手动发送会使用错误的 ID 导致服务端无法匹配）。

    // 内部执行函数，支持重试
    const executeCall = async (): Promise<{ ok: boolean; data?: any; error?: string; usage?: any }> => {
      const controller = new AbortController();
      const to = setTimeout(() => {
        controller.abort('timeout');
      }, timeoutMs);
      try {
        const result = await rt.client.callTool(
          { name: rawName, arguments: args ?? {} },
          undefined,
          { signal: controller.signal }
        );
        clearTimeout(to);
        const elapsed = Date.now() - started;

        // MCP 协议规范：错误信息在 content 数组的 text 字段中
        const extractErrorMessage = (): string => {
          if (Array.isArray(result.content)) {
            const textContent = result.content.find((c: any) => c.type === 'text' && c.text);
            if (textContent?.text) return textContent.text;
          }
          if ((result as any).error?.message) return (result as any).error.message;
          return i18next.t('mcp:service.tool_returned_error');
        };

        // MCP 规范安全：清洗工具返回结果
        const rawData = result.content ?? (result as any).data ?? null;
        const sanitizedData = Array.isArray(rawData)
          ? sanitizeToolResultContent(clampJsonDepth(rawData, MCP_RESULT_MAX_DEPTH))
          : rawData != null ? clampJsonDepth(rawData, MCP_RESULT_MAX_DEPTH) : null;

        if (result.isError) {
          const errorMsg = extractErrorMessage();
          emitMcpDebugEvent('mcp-tool-call-error', {
            serverId: rt.cfg.id, toolName, error: errorMsg, duration: elapsed, callId,
          });
          return {
            ok: false,
            data: sanitizedData,
            error: errorMsg,
            usage: { elapsed_ms: elapsed, tool_name: toolName, source: 'mcp-frontend', trace_id: callId }
          };
        } else {
          emitMcpDebugEvent('mcp-tool-call-success', {
            serverId: rt.cfg.id, toolName, result: sanitizedData, duration: elapsed, callId,
          });
          return {
            ok: true,
            data: sanitizedData,
            error: undefined,
            usage: { elapsed_ms: elapsed, tool_name: toolName, source: 'mcp-frontend', trace_id: callId }
          };
        }
      } catch (e: any) {
        clearTimeout(to);
        throw e; // 由外层处理
      }
    };

    // 首次尝试
    try {
      return await executeCall();
    } catch (firstError: any) {
      const elapsed = Date.now() - started;

      // 认证错误不重试
      if (isAuthError(firstError)) {
        const errorMsg = getErrorMessage(firstError);
        const finalError = i18next.t('mcp:service.auth_failed_for_server', { serverId: rt.cfg.id, error: errorMsg });
        emitMcpDebugEvent('mcp-tool-call-error', {
          serverId: rt.cfg.id, toolName, error: finalError, duration: elapsed, callId, isAuthError: true,
        });
        rt.error = i18next.t('mcp:service.auth_failed_check_key');
        this.emitStatus();
        return { ok: false, error: finalError, usage: { elapsed_ms: elapsed, tool_name: toolName, source: 'mcp-frontend', trace_id: callId } };
      }

      // 连接断开错误：自动重连并重试一次
      if (isConnectionError(firstError)) {
        debugLog.warn(`[MCP] Tool call failed due to connection error for ${rt.cfg.id}, attempting reconnect and retry`, {
          toolName, error: getErrorMessage(firstError),
        });
        emitMcpDebugEvent('mcp-tool-call-retry', {
          serverId: rt.cfg.id, toolName, callId, reason: 'connection_error',
        });

        // 标记为断开并尝试重连
        rt.connected = false;
        rt.connectPromise = undefined;
        this.emitStatus();

        const reconnected = await this.ensureConnected(rt);
        if (reconnected) {
          // 重试一次
          try {
            return await executeCall();
          } catch (retryError: any) {
            const retryElapsed = Date.now() - started;
            const retryMsg = getErrorMessage(retryError);
            emitMcpDebugEvent('mcp-tool-call-error', {
              serverId: rt.cfg.id, toolName, error: retryMsg, duration: retryElapsed, callId, isRetry: true,
            });
            return { ok: false, error: retryMsg, usage: { elapsed_ms: retryElapsed, tool_name: toolName, source: 'mcp-frontend', trace_id: callId } };
          }
        }
      }

      // 其他错误直接返回
      const errorMsg = getErrorMessage(firstError);
      emitMcpDebugEvent('mcp-tool-call-error', {
        serverId: rt.cfg.id, toolName, error: errorMsg, duration: elapsed, callId,
      });
      return { ok: false, error: errorMsg, usage: { elapsed_ms: elapsed, tool_name: toolName, source: 'mcp-frontend', trace_id: callId } };
    }
  }

  private pickServerByTool(name: string): ServerRuntime | undefined {
    // 优先匹配最长的 namespace（防止短前缀误匹配）
    let bestMatch: ServerRuntime | undefined;
    let bestLen = 0;

    for (const rt of this.servers.values()) {
      if (rt.cfg.namespace && name.startsWith(rt.cfg.namespace)) {
        if (rt.cfg.namespace.length > bestLen) {
          bestMatch = rt;
          bestLen = rt.cfg.namespace.length;
        }
      }
    }

    if (bestMatch) return bestMatch;

    // Fallback：namespace 未匹配时，遍历 toolCacheByServer 查找包含该工具名的服务器
    for (const [sid, cache] of this.toolCacheByServer.entries()) {
      if (cache.tools.some(t => t.name === name)) {
        const rt = this.servers.get(sid);
        if (rt) return rt;
      }
    }

    return undefined;
  }

  /**
   * 根据工具的 JSON Schema 验证参数
   * @param schema 工具的 inputSchema
   * @param args 传入的参数
   * @returns 验证错误信息，null 表示验证通过
   */
  private validateToolArgs(schema: any, args: Record<string, unknown>): string | null {
    if (!schema || typeof schema !== 'object') return null;

    // 检查必需参数
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const param of required) {
        if (args[param] === undefined || args[param] === null) {
          return i18next.t('mcp:service.missing_required_param', { param });
        }
      }
    }

    // 基本类型检查（仅在 schema.properties 存在时）
    const properties = schema.properties;
    if (properties && typeof properties === 'object') {
      for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue;
        
        const propSchema = properties[key];
        if (!propSchema || typeof propSchema !== 'object') continue;
        
        const expectedType = (propSchema as any).type;
        if (!expectedType) continue;

        const actualType = typeof value;
        
        // JSON Schema 类型映射
        if (expectedType === 'string' && actualType !== 'string') {
          return i18next.t('mcp:service.param_type_string', { key, actual: actualType });
        }
        if (expectedType === 'number' && actualType !== 'number') {
          return i18next.t('mcp:service.param_type_number', { key, actual: actualType });
        }
        if (expectedType === 'integer') {
          if (actualType !== 'number' || !Number.isInteger(value)) {
            return i18next.t('mcp:service.param_type_integer', { key });
          }
        }
        if (expectedType === 'boolean' && actualType !== 'boolean') {
          return i18next.t('mcp:service.param_type_boolean', { key, actual: actualType });
        }
        if (expectedType === 'array' && !Array.isArray(value)) {
          return i18next.t('mcp:service.param_type_array', { key, actual: actualType });
        }
        if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(value))) {
          return i18next.t('mcp:service.param_type_object', { key });
        }
      }
    }

    return null;
  }

  /**
   * 从缓存中查找工具的 Schema
   */
  private findToolSchema(toolName: string, serverId: string): any {
    const cache = this.toolCacheByServer.get(serverId);
    if (!cache?.tools) return null;
    
    const tool = cache.tools.find(t => t.name === toolName);
    return tool?.input_schema || null;
  }

  dispose() {
    // 标记正在销毁，阻止 onclose 回调触发重连
    this._disposing = true;

    // 保存缓存到持久化存储后再清理
    this.saveCacheToStorage();

    for (const rt of this.servers.values()) {
      try {
        if (rt.retryTimer) { clearTimeout(rt.retryTimer); rt.retryTimer = undefined; }
        if (rt.keepaliveTimer) { clearInterval(rt.keepaliveTimer); rt.keepaliveTimer = undefined; }
        // 清除被动断开检测回调，避免 close() 触发重连逻辑
        rt.client.onclose = undefined;
        rt.client.onerror = undefined;
        rt.client.close();
        // 显式关闭 transport，释放 Tauri HTTP 资源（避免 resource id invalid 泄漏）
        if (rt.transport) {
          try { rt.transport.close?.(); } catch { /* best-effort */ }
          rt.transport = undefined;
        }
        
        // 触发断开连接事件
        emitMcpDebugEvent('mcp-disconnect', {
          serverId: rt.cfg.id,
        });
      } catch {
        // Expected: client.close() may throw if connection was never established or already closed
      } 
    }
    this.servers.clear();
    
    // 注意：不清空缓存，以便下次启动时可以使用
    // this.toolCache = null;
  }
}

export const McpService = new McpServiceImpl();

// Frontend bridge helpers for Tauri events
export type BridgeRequest = { correlationId: string; tool: string; args?: any; timeoutMs?: number };
export type BridgeResponse = { correlationId: string; ok: boolean; data?: any; error?: string; usage?: any };

let bridgeInitialized = false;

export function setupTauriBridge() {
  if (bridgeInitialized) return;
  if (typeof window === 'undefined') return;
  const hasTauri = Boolean((window as any)?.__TAURI_INTERNALS__ || (window as any)?.__TAURI_IPC__);
  if (!hasTauri) return;
  bridgeInitialized = true;

  // Lazy import to avoid hard dependency when running in web-only context
  import('@tauri-apps/api/event')
    .then(({ listen, emit }) => {
      listen<BridgeRequest>('mcp-bridge-request', async (ev) => {
        const req = ev.payload;
        const res = await McpService.callTool(req.tool, req.args, req.timeoutMs ?? 15000);
        const payload: BridgeResponse = { correlationId: req.correlationId, ...res } as any;
        // Best-effort emit: response delivery failure is non-fatal; the caller will time out
        try { await emit('mcp-bridge-response', payload); } catch { /* best-effort */ }
        try { await emit(`mcp-bridge-response:${req.correlationId}`, payload); } catch { /* best-effort */ }
      }).catch((err) => { debugLog.error('[MCP] Failed to register bridge listener for mcp-bridge-request:', err); });

      listen<{ correlationId: string }>('mcp-bridge-tools-request', async (ev) => {
        const { correlationId } = ev.payload || { correlationId: '' };
        const tools = await McpService.listTools().catch(() => []);
        const resp = { correlationId, tools };
        try { await emit('mcp-bridge-tools-response', resp); } catch { /* best-effort */ }
        try { await emit(`mcp-bridge-tools-response:${correlationId}`, resp); } catch { /* best-effort */ }
      }).catch((err) => { debugLog.error('[MCP] Failed to register bridge listener for mcp-bridge-tools-request:', err); });

      listen<{ correlationId: string }>('mcp-bridge-prompts-request', async (ev) => {
        const { correlationId } = ev.payload || { correlationId: '' };
        const prompts = await McpService.listPrompts().catch(() => []);
        const resp = { correlationId, prompts };
        try { await emit('mcp-bridge-prompts-response', resp); } catch { /* best-effort */ }
        try { await emit(`mcp-bridge-prompts-response:${correlationId}`, resp); } catch { /* best-effort */ }
      }).catch((err) => { debugLog.error('[MCP] Failed to register bridge listener for mcp-bridge-prompts-request:', err); });

      listen<{ correlationId: string }>('mcp-bridge-resources-request', async (ev) => {
        const { correlationId } = ev.payload || { correlationId: '' };
        const resources = await McpService.listResources().catch(() => []);
        const resp = { correlationId, resources };
        try { await emit('mcp-bridge-resources-response', resp); } catch { /* best-effort */ }
        try { await emit(`mcp-bridge-resources-response:${correlationId}`, resp); } catch { /* best-effort */ }
      }).catch((err) => { debugLog.error('[MCP] Failed to register bridge listener for mcp-bridge-resources-request:', err); });

      listen<{ correlationId: string; uri: string }>('mcp-bridge-resource-read-request', async (ev) => {
        const { correlationId, uri } = ev.payload || { correlationId: '', uri: '' };
        try {
          const content = await McpService.readResource(uri);
          const respOk = { correlationId, ok: true, content };
          await emit('mcp-bridge-resource-read-response', respOk);
          await emit(`mcp-bridge-resource-read-response:${correlationId}`, respOk);
        } catch (e: any) {
          const respErr = { correlationId, ok: false, error: getErrorMessage(e) } as any;
          await emit('mcp-bridge-resource-read-response', respErr);
          await emit(`mcp-bridge-resource-read-response:${correlationId}`, respErr);
        }
      }).catch((err) => { debugLog.error('[MCP] Failed to register bridge listener for mcp-bridge-resource-read-request:', err); });
    })
    .catch((err) => {
      debugLog.warn('[MCP] setupTauriBridge failed:', err);
      bridgeInitialized = false;
    });
}

type BootstrapOptions = { preheat?: boolean; force?: boolean };

function guessNamespace(item: any): string | undefined {
  // 优先使用 namespace，其次 name（用户设置的友好名称），最后 id
  const ns = item?.namespace || item?.name || item?.id;
  if (!ns) return undefined;
  return String(ns).endsWith(':') ? String(ns) : `${String(ns)}:`;
}

function toServerConfigs(list: any[]): McpConfig['servers'] {
  const servers: McpConfig['servers'] = [];
  const parseInlineCommand = (raw: string): { exec: string; args: string[] } => {
    const trimmed = raw.trim();
    if (!trimmed) return { exec: '', args: [] };
    if ((trimmed.startsWith('"') && trimmed.indexOf('"', 1) > 0) || (trimmed.startsWith("'") && trimmed.indexOf("'", 1) > 0)) {
      const quote = trimmed[0];
      const closing = trimmed.indexOf(quote, 1);
      if (closing > 0) {
        const exec = trimmed.slice(1, closing);
        const remainder = trimmed.slice(closing + 1).trim();
        const args = remainder.length > 0 ? remainder.split(/\s+/).filter(Boolean) : [];
        return { exec, args };
      }
    }
    const pieces = trimmed.split(/\s+/).filter(Boolean);
    const [exec, ...rest] = pieces;
    return { exec: exec ?? '', args: rest };
  };

  for (const item of list) {
    if (!item) continue;
    const transportType = item.transportType || item.transport || 'sse';
    const headers: Record<string, string> = { ...(item.headers || {}) };
    if (item.apiKey && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${item.apiKey}`;
    }
    if (item.apiKey && !headers['X-API-Key']) {
      headers['X-API-Key'] = String(item.apiKey);
    }

    const namespace = guessNamespace(item);

    const resolveUrl = (...candidates: any[]) => {
      for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
      }
      return undefined;
    };

    if (transportType === 'stdio') {
      const commandSource = typeof item.command === 'string'
        ? item.command
        : (item?.fetch?.command ?? (item?.mcpServers && typeof item.mcpServers === 'object' ? (Object.values(item.mcpServers)[0] as { command?: string } | undefined)?.command : undefined));
      const trimmedCommand = commandSource ? String(commandSource).trim() : '';
      if (trimmedCommand) {
        const rawArgs = item.args ?? item?.fetch?.args ?? [];
        let argsArray = Array.isArray(rawArgs)
          ? rawArgs.map((arg: any) => String(arg).trim()).filter(arg => arg.length > 0)
          : typeof rawArgs === 'string' && rawArgs.trim().length > 0
            ? rawArgs.split(',').map(seg => seg.trim()).filter(seg => seg.length > 0)
            : [];
        const inline = parseInlineCommand(trimmedCommand);
        const executable = inline.exec || trimmedCommand.split(/\s+/)[0] || trimmedCommand;
        if (argsArray.length === 0 && inline.args.length > 0) {
          argsArray = inline.args;
        }
        const execLower = executable.toLowerCase();
        const shouldApplyDefaultArgs =
          argsArray.length === 0 &&
          inline.args.length === 0 &&
          (execLower === 'npx' || execLower === 'npx.cmd' || execLower === 'npx.exe');
        if (shouldApplyDefaultArgs) {
          argsArray = [...DEFAULT_STDIO_ARGS];
        }
        const envObj = (() => {
          if (item.env && typeof item.env === 'object') return item.env as Record<string, string>;
          if (item?.fetch?.env && typeof item.fetch.env === 'object') return item.fetch.env as Record<string, string>;
          return {};
        })();
        const framingRaw = item.framing || item.framingMode || item?.fetch?.framing;
        const framing = framingRaw ? String(framingRaw).toLowerCase() : undefined;
        const cwd = typeof item.cwd === 'string' ? item.cwd : (typeof item.workingDir === 'string' ? item.workingDir : undefined);
        servers.push({
          id: item.id || item.name || executable,
          type: 'stdio',
          command: executable,
          args: argsArray,
          env: envObj,
          cwd,
          framing: framing === 'jsonl' ? 'jsonl' : 'content_length',
          namespace,
        });
      }
      continue;
    }

    if ((transportType === 'websocket' || transportType === 'ws') && item?.url) {
      servers.push({
        id: item.id || item.name || String(item.url),
        type: 'websocket',
        url: String(item.url),
        namespace,
        headers,
      });
      continue;
    }

    if (transportType === 'streamable-http' || transportType === 'streamable_http') {
      const httpUrl = resolveUrl(item?.fetch?.url, item?.endpoint, item?.url, item?.mcpServers?.fetch?.url);
      if (httpUrl) {
        servers.push({
          id: item.id || item.name || String(httpUrl),
          type: 'streamable_http',
          url: String(httpUrl),
          namespace,
          headers,
        });
      }
      continue;
    }

    const sseUrl = resolveUrl(item?.fetch?.url, item?.endpoint, item?.url, item?.mcpServers?.fetch?.url);
    if (sseUrl) {
      servers.push({
        id: item.id || item.name || String(sseUrl),
        type: 'sse',
        url: String(sseUrl),
        namespace,
        headers,
      });
    }
  }
  return servers;
}

async function loadServersFromSettings(): Promise<McpConfig['servers']> {
  let listStr: string | null = null;

  if (isTauriEnvironment) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      listStr = await invoke<string | null>('get_setting', { key: 'mcp.tools.list' }).catch(() => null);
    } catch (err: unknown) {
      debugLog.warn('[MCP] Failed to load MCP servers via Tauri invoke:', err);
    }
  }

  if (!listStr && typeof window !== 'undefined') {
    try {
      listStr = window.localStorage.getItem('mcp.tools.list');
    } catch (err: unknown) {
      debugLog.warn('[MCP] Failed to read MCP servers from localStorage:', err);
    }
  }

  const arr = (() => {
    try { return listStr ? JSON.parse(listStr) : []; } catch (e: unknown) { console.warn('[MCP] Failed to parse mcp.tools.list JSON:', e); return []; }
  })();

  return toServerConfigs(Array.isArray(arr) ? arr : []);
}

async function loadCacheTtlFromSettings(): Promise<number | undefined> {
  if (isTauriEnvironment) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const [perfTtl, legacyTtl] = await Promise.all([
        invoke<string | null>('get_setting', { key: 'mcp.performance.cache_ttl_ms' }).catch(() => null),
        invoke<string | null>('get_setting', { key: 'mcp.tools.cache_ttl_ms' }).catch(() => null),
      ]);
      const candidates = [perfTtl, legacyTtl].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      for (const raw of candidates) {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return parsed;
        }
      }
    } catch (err: unknown) {
      debugLog.warn('[MCP] Failed to load MCP cache TTL via Tauri invoke:', err);
    }
  }
  try {
    const local = typeof window !== 'undefined' ? window.localStorage.getItem('mcp.performance.cache_ttl_ms') || window.localStorage.getItem('mcp.tools.cache_ttl_ms') : null;
    if (local) {
      const parsed = parseInt(local, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  } catch (e: unknown) {
    console.warn('[MCP] Failed to read cache TTL from localStorage:', e);
  }
  return undefined;
}

export async function bootstrapMcpFromSettings(options: BootstrapOptions = {}): Promise<void> {
  if (bootstrapInFlight) {
    return bootstrapInFlight;
  }

  bootstrapInFlight = (async () => {
    setupTauriBridge();
    const servers = await loadServersFromSettings();
    const cacheTtlMs = await loadCacheTtlFromSettings();
    const signature = JSON.stringify({
      servers: servers.map((s) => ({
        id: s.id,
        type: s.type,
        url: s.url ?? '',
        namespace: s.namespace ?? '',
        command: s.command ?? '',
        args: s.args ?? [],
      })),
      cacheTtlMs: cacheTtlMs ?? 300_000,
    });
    const now = Date.now();
    if (
      !options.force &&
      signature === lastBootstrapSignature &&
      now - lastBootstrapCompletedAt < BOOTSTRAP_COOLDOWN_MS
    ) {
      return;
    }

    McpService.init({ servers, cacheTtlMs: cacheTtlMs ?? 300_000 });
    if (servers.length === 0) {
      // 即使没有服务器，也触发 ready 事件让 UI 更新
      emitMcpDebugEvent('mcp-bootstrap-ready', { servers: [], toolsCount: 0 });
      lastBootstrapSignature = signature;
      lastBootstrapCompletedAt = now;
      return;
    }

    try {
      await McpService.connectAll();
      if (options.preheat && isTauriEnvironment) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('preheat_mcp_tools');
        } catch (err: unknown) {
          const msg = getErrorMessage(err).toLowerCase();
          const notFound = msg.includes('command') && msg.includes('not found') && msg.includes('preheat_mcp_tools');
          if (import.meta.env?.DEV && notFound) {
            debugLog.log('[MCP] preheat_mcp_tools not available in dev');
          } else {
            debugLog.warn('[MCP] preheat_mcp_tools invoke failed:', err);
          }
        }
      }
    } catch (err: unknown) {
      debugLog.warn('[MCP] connectAll failed:', err);
    }
    
    // 🔧 修复竞态条件：在连接完成后触发 ready 事件
    // DialogControlContext 监听此事件以重新加载工具列表
    const status = await McpService.status();
    emitMcpDebugEvent('mcp-bootstrap-ready', {
      servers: status.servers,
      toolsCount: status.toolsCount,
      connected: status.connected,
    });
    lastBootstrapSignature = signature;
    lastBootstrapCompletedAt = Date.now();
  })();

  try {
    await bootstrapInFlight;
  } finally {
    bootstrapInFlight = null;
  }
}
