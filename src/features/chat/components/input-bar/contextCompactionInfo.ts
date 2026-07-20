/**
 * 上下文用量弹层的压缩状态数据（纯函数）。
 *
 * 从 Store 已有的 compaction_summary 块元数据（tokensBefore / tokensAfter /
 * isActive）中提取展示信息，不依赖任何后端新接口。
 */

export interface ContextCompactionInfo {
  /** 该压缩视图当前是否生效 */
  isActive: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  compactedMessageCount?: number;
}

interface CompactionBlockLike {
  type?: string;
  toolOutput?: unknown;
}

interface MessageLike {
  blockIds?: string[];
}

export interface CompactionInfoSource {
  messageOrder: string[];
  messageMap: Map<string, MessageLike>;
  blocks: Map<string, CompactionBlockLike>;
}

function readCount(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 解析 compaction_summary 块的 toolOutput 元数据（JSON 字符串或对象） */
export function readCompactionInfo(toolOutput: unknown): ContextCompactionInfo | null {
  let parsed = toolOutput;
  if (typeof toolOutput === 'string') {
    try {
      parsed = JSON.parse(toolOutput) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const info: ContextCompactionInfo = {
    // 后端未写 isActive 时按 active 处理（与 compactionSummary 块的撤销按钮语义一致）
    isActive: raw.isActive !== false,
  };
  const tokensBefore = readCount(raw, 'tokensBefore');
  const tokensAfter = readCount(raw, 'tokensAfter');
  const compactedMessageCount = readCount(raw, 'compactedMessageCount');
  if (tokensBefore !== undefined) info.tokensBefore = tokensBefore;
  if (tokensAfter !== undefined) info.tokensAfter = tokensAfter;
  if (compactedMessageCount !== undefined) info.compactedMessageCount = compactedMessageCount;
  return info;
}

/**
 * 从会话末尾倒序查找最近一个 active 的 compaction_summary 块。
 * 找不到（或最近一个已被撤销）返回 null。
 */
export function findActiveCompactionInfo(source: CompactionInfoSource): ContextCompactionInfo | null {
  const messageOrder = Array.isArray(source.messageOrder) ? source.messageOrder : [];
  const messageMap = source.messageMap instanceof Map ? source.messageMap : new Map<string, MessageLike>();
  const blocks = source.blocks instanceof Map ? source.blocks : new Map<string, CompactionBlockLike>();

  for (let i = messageOrder.length - 1; i >= 0; i -= 1) {
    const message = messageMap.get(messageOrder[i]);
    const blockIds = message?.blockIds ?? [];
    for (let j = blockIds.length - 1; j >= 0; j -= 1) {
      const block = blocks.get(blockIds[j]);
      if (block?.type !== 'compaction_summary') continue;
      const info = readCompactionInfo(block.toolOutput);
      if (!info) continue;
      return info.isActive ? info : null;
    }
  }
  return null;
}
