const TIMELINE_KEY_PREFIXES = ['rag_', 'graph_', 'memory_', 'web_', 'tool_event_', 'chain_of_thought', 'thinking_content'];
const STRING_PREVIEW_LIMIT = 240;

const truncateString = (value: string, limit: number = STRING_PREVIEW_LIMIT): string => {
  if (typeof value !== 'string') return value as unknown as string;
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  return `${head}…(+${value.length - head.length})`;
};

const sanitizePrimitive = (value: unknown): unknown => {
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value);
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizePrimitive(item));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const limited = entries.slice(0, 20).reduce<Record<string, unknown>>((acc, [key, val]) => {
      acc[key] = sanitizePrimitive(val);
      return acc;
    }, {});
    if (entries.length > 20) limited.__truncated__ = entries.length - 20;
    return limited;
  }
  return value;
};

export type DebugMessageSnapshot = {
  stableId: string;
  role: string;
  timestamp?: string;
  contentPreview?: string;
  contentLength?: number;
  thinkingLength?: number;
  metadataKeys: string[];
  timelineMeta: Record<string, unknown>;
  ragSourcesCount?: number;
  memorySourcesCount?: number;
  graphSourcesCount?: number;
  webSearchSourcesCount?: number;
  toolCall?: { id?: string; name?: string; hasArgs?: boolean } | null;
  toolResult?: { callId?: string; ok?: boolean; hasError?: boolean; citationsCount?: number } | null;
  hasThinking?: boolean;
  metaChain?: boolean;
  metaThinking?: boolean;
};

const pickTimelineMeta = (meta: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  Object.entries(meta || {}).forEach(([key, value]) => {
    const lower = key.toLowerCase();
    if (TIMELINE_KEY_PREFIXES.some((prefix) => lower.includes(prefix))) {
      result[key] = sanitizePrimitive(value);
    }
  });
  return result;
};

const extractContentPreview = (content: unknown): { preview?: string; length?: number } => {
  if (content == null) return {};
  if (typeof content === 'string') {
    return { preview: truncateString(content), length: content.length };
  }
  if (Array.isArray(content)) {
    try {
      const json = JSON.stringify(content);
      return { preview: truncateString(json), length: json.length };
    } catch {
      return { preview: '[unserializable content]', length: Array.isArray(content) ? content.length : undefined };
    }
  }
  if (typeof content === 'object') {
    try {
      const json = JSON.stringify(content);
      return { preview: truncateString(json), length: json.length };
    } catch {
      return { preview: '[object content]', length: undefined };
    }
  }
  return { preview: String(content) };
};

export const sanitizeDebugMessage = (message: any, fallbackStableId: string = ''): DebugMessageSnapshot => {
  const stableId = (message?._stableId || message?.stableId || message?.persistent_stable_id || message?.id || fallbackStableId || '').toString();
  const role = (message?.role || 'assistant').toString();
  const { preview: contentPreview, length: contentLength } = extractContentPreview(message?.content);
  const metaRaw = { ...(message?.metadata || {}), ...(message?._meta || {}) } as Record<string, unknown>;
  const timelineMeta = pickTimelineMeta(metaRaw);
  const toolCallRaw = message?.tool_call;
  const toolResultRaw = message?.tool_result;

  const sanitizeToolArgs = (args: unknown): boolean => {
    if (!args) return false;
    if (typeof args === 'string') return args.trim().length > 0;
    if (Array.isArray(args)) return args.length > 0;
    if (typeof args === 'object') return Object.keys(args as Record<string, unknown>).length > 0;
    return false;
  };

  return {
    stableId,
    role,
    timestamp: message?.timestamp,
    contentPreview,
    contentLength,
    thinkingLength: typeof message?.thinking_content === 'string' ? message.thinking_content.length : 0,
    metadataKeys: Object.keys(metaRaw || {}),
    timelineMeta,
    ragSourcesCount: Array.isArray(message?.rag_sources) ? message.rag_sources.length : undefined,
    memorySourcesCount: Array.isArray(message?.memory_sources) ? message.memory_sources.length : undefined,
    graphSourcesCount: Array.isArray(message?.graph_sources) ? message.graph_sources.length : undefined,
    webSearchSourcesCount: Array.isArray(message?.web_search_sources) ? message.web_search_sources.length : undefined,
    toolCall: toolCallRaw
      ? {
          id: toolCallRaw.id,
          name: toolCallRaw.tool_name || (toolCallRaw.name ? String(toolCallRaw.name) : undefined),
          hasArgs: sanitizeToolArgs(toolCallRaw.args_json ?? toolCallRaw.args),
        }
      : null,
    toolResult: toolResultRaw
      ? {
          callId: toolResultRaw.call_id,
          ok: toolResultRaw.ok,
          hasError: Boolean(toolResultRaw.error || toolResultRaw.error_details),
          citationsCount: Array.isArray(toolResultRaw.citations) ? toolResultRaw.citations.length : undefined,
        }
      : null,
    hasThinking: typeof message?.thinking_content === 'string' && message.thinking_content.length > 0,
    metaChain: Boolean(metaRaw?.chain_of_thought_details),
    metaThinking: Boolean(metaRaw?.thinking_content),
  };
};

export const sanitizeDebugMessageList = (list: unknown[]): DebugMessageSnapshot[] => {
  if (!Array.isArray(list)) return [];
  return list.map((message, index) => sanitizeDebugMessage(message as any, `msg_${index}`));
};

export const pickTimelineMetaKeys = pickTimelineMeta;


