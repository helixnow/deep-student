/**
 * 网络监控模块
 * 监控 HTTP/Fetch 请求和 WebSocket 消息
 */

import type { NetworkRequest, WebSocketMessage, NetworkMonitorState } from '../types';

// 生成唯一 ID
const generateId = () => `net_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// 需要脱敏的请求头名称（小写）
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

/**
 * 对请求头进行脱敏处理，隐藏敏感凭据
 */
function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return redacted;
}

// 模块状态
const state: NetworkMonitorState = {
  enabled: false,
  requests: [],
  websocketMessages: [],
  maxEntries: 200,
};

// 原始方法引用
let originalFetch: typeof fetch | null = null;
let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalWebSocket: typeof WebSocket | null = null;

// WebSocket 实例映射
const wsInstances = new Map<WebSocket, string>();

/**
 * 添加请求记录
 */
function addRequest(request: Omit<NetworkRequest, 'id'>) {
  if (!state.enabled) return;
  
  const networkRequest: NetworkRequest = {
    ...request,
    id: generateId(),
  };
  
  state.requests.push(networkRequest);
  
  // 限制最大数量
  while (state.requests.length > state.maxEntries) {
    state.requests.shift();
  }
  
  // 触发事件通知
  window.dispatchEvent(new CustomEvent('mcp-debug:network', { detail: networkRequest }));
  
  return networkRequest.id;
}

/**
 * 更新请求记录
 */
function updateRequest(id: string, updates: Partial<NetworkRequest>) {
  const request = state.requests.find(r => r.id === id);
  if (request) {
    Object.assign(request, updates);
  }
}

/**
 * 添加 WebSocket 消息
 */
function addWebSocketMessage(message: Omit<WebSocketMessage, 'id'>) {
  if (!state.enabled) return;
  
  const wsMessage: WebSocketMessage = {
    ...message,
    id: generateId(),
  };
  
  state.websocketMessages.push(wsMessage);
  
  // 限制最大数量
  while (state.websocketMessages.length > state.maxEntries) {
    state.websocketMessages.shift();
  }
  
  // 触发事件通知
  window.dispatchEvent(new CustomEvent('mcp-debug:websocket', { detail: wsMessage }));
}

/**
 * 拦截 Fetch API
 */
function interceptFetch() {
  if (originalFetch) return;
  
  originalFetch = window.fetch;
  
  window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const startTime = Date.now();
    
    // 创建请求记录
    const requestId = addRequest({
      url,
      method: method.toUpperCase(),
      requestHeaders: redactHeaders(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined),
      requestBody: init?.body,
      startTime,
      type: 'fetch',
    });
    
    try {
      const response = await originalFetch!.call(window, input, init);
      const endTime = Date.now();
      
      // 更新请求记录
      if (requestId) {
        // 克隆响应以读取 body
        const clonedResponse = response.clone();
        let responseBody: unknown;
        try {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            responseBody = await clonedResponse.json();
          } else if (contentType.includes('text/')) {
            responseBody = await clonedResponse.text();
          }
        } catch {
          // 忽略解析错误
        }
        
        updateRequest(requestId, {
          status: response.status,
          statusText: response.statusText,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseBody,
          responseType: response.headers.get('content-type') || undefined,
          endTime,
          duration: endTime - startTime,
        });
      }
      
      return response;
    } catch (error: unknown) {
      const endTime = Date.now();
      
      if (requestId) {
        updateRequest(requestId, {
          error: error instanceof Error ? error.message : String(error),
          endTime,
          duration: endTime - startTime,
        });
      }
      
      throw error;
    }
  };
}

/**
 * 拦截 XMLHttpRequest
 */
function interceptXHR() {
  if (originalXHROpen) return;
  
  originalXHROpen = XMLHttpRequest.prototype.open;
  originalXHRSend = XMLHttpRequest.prototype.send;
  
  const requestMap = new WeakMap<XMLHttpRequest, { id: string; url: string; method: string; startTime: number }>();
  
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
    requestMap.set(this, {
      id: '',
      url: typeof url === 'string' ? url : url.href,
      method: method.toUpperCase(),
      startTime: 0,
    });
    return originalXHROpen!.apply(this, [method, url, ...args] as any);
  };
  
  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const reqInfo = requestMap.get(this);
    if (reqInfo && state.enabled) {
      reqInfo.startTime = Date.now();
      
      const requestId = addRequest({
        url: reqInfo.url,
        method: reqInfo.method,
        requestBody: body,
        startTime: reqInfo.startTime,
        type: 'xhr',
      });
      
      if (requestId) {
        reqInfo.id = requestId;
      }
      
      // 监听完成事件
      this.addEventListener('loadend', () => {
        if (reqInfo.id) {
          const endTime = Date.now();
          let responseBody: unknown;
          
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              const contentType = this.getResponseHeader('content-type') || '';
              if (contentType.includes('application/json')) {
                responseBody = JSON.parse(this.responseText);
              } else {
                responseBody = this.responseText;
              }
            } else if (this.responseType === 'json') {
              responseBody = this.response;
            }
          } catch {
            // 忽略解析错误
          }
          
          updateRequest(reqInfo.id, {
            status: this.status,
            statusText: this.statusText,
            responseBody,
            responseType: this.getResponseHeader('content-type') || undefined,
            endTime,
            duration: endTime - reqInfo.startTime,
          });
        }
      });
      
      this.addEventListener('error', () => {
        if (reqInfo.id) {
          const endTime = Date.now();
          updateRequest(reqInfo.id, {
            error: 'Network error',
            endTime,
            duration: endTime - reqInfo.startTime,
          });
        }
      });
      
      this.addEventListener('abort', () => {
        if (reqInfo.id) {
          const endTime = Date.now();
          updateRequest(reqInfo.id, {
            aborted: true,
            endTime,
            duration: endTime - reqInfo.startTime,
          });
        }
      });
    }
    
    return originalXHRSend!.call(this, body);
  };
}

/**
 * 拦截 WebSocket
 */
function interceptWebSocket() {
  if (originalWebSocket) return;
  
  originalWebSocket = window.WebSocket;
  
  window.WebSocket = class extends originalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      
      const socketId = generateId();
      const wsUrl = typeof url === 'string' ? url : url.href;
      wsInstances.set(this, socketId);
      
      // 监听连接打开
      this.addEventListener('open', () => {
        addWebSocketMessage({
          socketId,
          url: wsUrl,
          direction: 'received',
          data: null,
          timestamp: Date.now(),
          type: 'open',
        });
      });
      
      // 监听消息接收
      this.addEventListener('message', (event) => {
        let data = event.data;
        try {
          if (typeof data === 'string') {
            data = JSON.parse(data);
          }
        } catch {
          // 保持原始数据
        }
        
        addWebSocketMessage({
          socketId,
          url: wsUrl,
          direction: 'received',
          data,
          timestamp: Date.now(),
          type: 'message',
        });
      });
      
      // 监听连接关闭
      this.addEventListener('close', (event) => {
        addWebSocketMessage({
          socketId,
          url: wsUrl,
          direction: 'received',
          data: { code: event.code, reason: event.reason },
          timestamp: Date.now(),
          type: 'close',
        });
      });
      
      // 监听错误
      this.addEventListener('error', () => {
        addWebSocketMessage({
          socketId,
          url: wsUrl,
          direction: 'received',
          data: { error: 'WebSocket error' },
          timestamp: Date.now(),
          type: 'error',
        });
      });
      
      // 拦截 send 方法
      const originalSend = this.send.bind(this);
      this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        let parsedData = data;
        try {
          if (typeof data === 'string') {
            parsedData = JSON.parse(data);
          }
        } catch {
          // 保持原始数据
        }
        
        addWebSocketMessage({
          socketId,
          url: wsUrl,
          direction: 'sent',
          data: parsedData,
          timestamp: Date.now(),
          type: 'message',
        });
        
        return originalSend(data);
      };
    }
  } as typeof WebSocket;
}

/**
 * 恢复原始方法
 */
function restore() {
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
  
  if (originalXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen;
    originalXHROpen = null;
  }
  
  if (originalXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend;
    originalXHRSend = null;
  }
  
  if (originalWebSocket) {
    window.WebSocket = originalWebSocket;
    originalWebSocket = null;
  }
}

/**
 * 启动网络监控
 */
export function start() {
  if (state.enabled) return;
  
  state.enabled = true;
  
  interceptFetch();
  interceptXHR();
  interceptWebSocket();
  
  console.log('[MCP-Debug] Network monitor started');
}

/**
 * 停止网络监控
 */
export function stop() {
  if (!state.enabled) return;
  
  state.enabled = false;
  restore();
  
  console.log('[MCP-Debug] Network monitor stopped');
}

/**
 * 获取请求记录
 */
export function get(filter?: { url?: string; status?: number; method?: string }): NetworkRequest[] {
  let results = [...state.requests];
  
  if (filter) {
    if (filter.url) {
      results = results.filter(r => r.url.includes(filter.url!));
    }
    if (filter.status !== undefined) {
      results = results.filter(r => r.status === filter.status);
    }
    if (filter.method) {
      results = results.filter(r => r.method === filter.method!.toUpperCase());
    }
  }
  
  return results;
}

/**
 * 获取 WebSocket 消息
 */
export function getWebSocket(): WebSocketMessage[] {
  return [...state.websocketMessages];
}

/**
 * 清除记录
 */
export function clear() {
  state.requests = [];
  state.websocketMessages = [];
}

/**
 * 获取状态
 */
export function getState(): NetworkMonitorState {
  return {
    ...state,
    requests: [...state.requests],
    websocketMessages: [...state.websocketMessages],
  };
}

export const networkMonitor = {
  start,
  stop,
  get,
  getWebSocket,
  clear,
  getState,
};

export default networkMonitor;
