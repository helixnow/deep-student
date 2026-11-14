/**
 * MCP 调试日志的脱敏（敏感键与疑似密钥的字符串）、截断（大字符串 / 大对象 / Error），以及高频 stdio 事件的节流。
 */

// 敏感字段列表
const SENSITIVE_KEYS = ['apiKey', 'api_key', 'token', 'password', 'secret', 'authorization', 'bearer'];

// 脱敏处理敏感信息
const sanitizeSensitive = (data: any): any => {
  if (typeof data === 'string') {
    // 检查是否像是 API key (长度 > 20 且包含字母数字)
    if (data.length > 20 && /^[A-Za-z0-9_-]+$/.test(data)) {
      return `${data.slice(0, 6)}***${data.slice(-4)} [已脱敏]`;
    }
    return data;
  }
  
  if (typeof data === 'object' && data !== null) {
    if (Array.isArray(data)) {
      return data.map(item => sanitizeSensitive(item));
    }
    
    const result: any = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      // RUST-FIX(RF-W19-mcp-api-key-field-unmasked): Tauri 版拿小写键去匹配 'apiKey'，永远不中，apiKey 字段只在值像密钥（21 位以上纯字母数字）时才被遮住
      if (SENSITIVE_KEYS.some(sk => lowerKey.includes(sk.toLowerCase()))) {
        // 敏感字段，脱敏处理
        if (typeof value === 'string' && value.length > 0) {
          result[key] = `***${value.slice(-4)} [已脱敏]`;
        } else {
          result[key] = '[已脱敏]';
        }
      } else {
        result[key] = sanitizeSensitive(value);
      }
    }
    return result;
  }
  
  return data;
};

// 截断大型数据，避免日志过大
export const truncateData = (data: any, maxLength = 500): any => {
  if (typeof data === 'string') {
    if (data.length > maxLength) {
      return data.slice(0, maxLength) + `... [截断 ${data.length - maxLength} 字符]`;
    }
    return data;
  }
  
  // 特殊处理 Error 对象
  if (data instanceof Error) {
    const head = `${data.name}: ${data.message}`;
    // RUST-FIX(RF-W19-mcp-error-message-repeated): Tauri 版总在 stack 前加“名称: 消息”，而 Chromium（WebView2、Electron）的 stack 首行就是它，于是重复一行
    const stackHead = Error.prototype.toString.call(data);
    const repeats = !!data.stack && (data.stack === stackHead || data.stack.startsWith(`${stackHead}\n`));
    const errorStr = repeats ? `${head}${data.stack!.slice(stackHead.length)}` : `${head}${data.stack ? '\n' + data.stack : ''}`;
    if (errorStr.length > maxLength) {
      return errorStr.slice(0, maxLength) + `... [截断 ${errorStr.length - maxLength} 字符]`;
    }
    return errorStr;
  }
  
  if (typeof data === 'object' && data !== null) {
    try {
      const str = JSON.stringify(data);
      if (str === '{}' || str === 'null') {
        // 可能是无法序列化的对象，尝试转换为字符串
        return String(data);
      }
      if (str.length > maxLength) {
        return `[对象过大: ${str.length} 字符, 已截断]`;
      }
      return data;
    } catch (e) {
      // JSON.stringify 失败时，返回字符串形式
      return String(data);
    }
  }
  return data;
};

export const sanitizeDetails = (details: any): any => {
  if (!details) return details;
  
  // 先脱敏，再截断
  const sanitized = sanitizeSensitive(details);

  // RUST-FIX(RF-W19-mcp-details-char-indexed): Tauri 版对字符串详情（如已被 truncateData 截成“[对象过大…]”的配置变更）做 Object.entries，展开成按字符下标的对象；数组也变成下标对象
  if (typeof sanitized !== 'object') return truncateData(sanitized);
  if (Array.isArray(sanitized)) return sanitized.map((value) => truncateData(value));

  const result: any = {};
  for (const [key, value] of Object.entries(sanitized)) {
    result[key] = truncateData(value);
  }
  
  return result;
};

// 节流控制：避免高频事件造成日志风暴
export class LogThrottler {
  private lastLogTime = new Map<string, number>();
  private throttleMs = 100; // 同类事件最小间隔
  private readonly MAX_ENTRIES = 1000; // 防止内存泄漏
  
  shouldLog(eventKey: string): boolean {
    const now = Date.now();
    const last = this.lastLogTime.get(eventKey) || 0;
    
    if (now - last < this.throttleMs) {
      return false;
    }
    
    this.lastLogTime.set(eventKey, now);
    
    // 定期清理过期条目，防止内存泄漏
    if (this.lastLogTime.size > this.MAX_ENTRIES) {
      const cutoff = now - 60000; // 清理1分钟前的条目
      for (const [key, time] of this.lastLogTime.entries()) {
        if (time < cutoff) {
          this.lastLogTime.delete(key);
        }
      }
    }
    
    return true;
  }
  
  setThrottleMs(ms: number) {
    this.throttleMs = ms;
  }
  
  clear() {
    this.lastLogTime.clear();
  }
}
