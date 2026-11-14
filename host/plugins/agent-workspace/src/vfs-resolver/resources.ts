/**
 * 笔记 / 作文 / 翻译 / 知识导图 / 灵感卡解引用：移植 `chat_v2/vfs_resolver.rs`。
 */
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import {
  essayContentRow, essayRoundRows, essaySessionInfoRow, insightCardContentRow,
  mindmapContentRow, noteContentRow, translationContentRow,
} from '../../repository/vfs-resolver-repository.ts';
import {
  debugLog, escapeXmlAttr, escapeXmlContent, silentVfsResolverLogger, textBlock,
  type ContentBlock, type VfsResolverLogger, type VfsResourceRef,
} from './model.ts';

/** `resolve_note`。 */
export function resolveNote(
  db: SqlExecutor,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  const row = noteContentRow(db, vfsRef.sourceId);
  if (row === null || row.data === null) {
    debugLog(logger, `[VfsResolver] Note has no content: ${vfsRef.sourceId}`);
    return [];
  }
  const title = row.title ?? vfsRef.name;
  debugLog(logger, `[VfsResolver] Resolved note ${vfsRef.sourceId}: ${row.data.length} chars`);
  return [textBlock(
    `<note title="${escapeXmlAttr(title)}">${escapeXmlContent(row.data)}</note>`,
  )];
}

/** `resolve_essay`：`essay_session_` 前缀走会话聚合。 */
export function resolveEssay(
  db: SqlExecutor,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  if (vfsRef.sourceId.startsWith('essay_session_')) {
    return resolveEssaySession(db, vfsRef, logger);
  }
  const row = essayContentRow(db, vfsRef.sourceId);
  if (row === null || row.data === null) {
    debugLog(logger, `[VfsResolver] Essay has no content: ${vfsRef.sourceId}`);
    return [];
  }
  const title = row.title ?? vfsRef.name;
  debugLog(logger, `[VfsResolver] Resolved essay ${vfsRef.sourceId}: ${row.data.length} chars`);
  return [textBlock(
    `<essay title="${escapeXmlAttr(title)}">${escapeXmlContent(row.data)}</essay>`,
  )];
}

/** `resolve_essay_session`：聚合所有轮次（最多 10 轮 / 20000 字符）。 */
export function resolveEssaySession(
  db: SqlExecutor,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  const MAX_CHARS = 20000;
  const MAX_ROUNDS = 10;

  const session = essaySessionInfoRow(db, vfsRef.sourceId);
  if (session.kind === 'notFound') {
    debugLog(logger, `[VfsResolver] Essay session not found: ${vfsRef.sourceId}`);
    return [];
  }
  if (session.kind === 'error') {
    logger.warn(`[VfsResolver] Failed to query essay session ${vfsRef.sourceId}: ${session.message}`);
    return [];
  }

  const rounds = essayRoundRows(db, vfsRef.sourceId);
  if (rounds.kind === 'error') {
    logger.warn(`[VfsResolver] Failed to query essay rounds for ${vfsRef.sourceId}: ${rounds.message}`);
    return [];
  }

  const displayTitle = session.info.title === '' ? vfsRef.name : session.info.title;
  const parts: string[] = [];
  let totalChars = 0;
  let truncated = false;

  const header = `# 作文会话: ${displayTitle}\n类型: ${session.info.essayType ?? '未知'}, 总轮次: ${session.info.totalRounds}`;
  totalChars += Array.from(header).length;
  parts.push(header);

  const roundsToTake = Math.min(MAX_ROUNDS, rounds.rows.length);
  if (rounds.rows.length > roundsToTake) truncated = true;

  for (const round of rounds.rows.slice(0, roundsToTake)) {
    const roundHeader = `\n## 第 ${round.roundNumber} 轮`;
    totalChars += Array.from(roundHeader).length;
    if (totalChars >= MAX_CHARS) {
      truncated = true;
      break;
    }
    parts.push(roundHeader);

    if (round.data !== null) {
      const remaining = Math.max(0, MAX_CHARS - totalChars);
      const chars = Array.from(round.data);
      if (chars.length > remaining) {
        parts.push(chars.slice(0, remaining).join(''));
        truncated = true;
        break;
      }
      totalChars += chars.length;
      parts.push(round.data);
    }
  }

  if (truncated) parts.push('\n\n[内容过长，已截断]');

  const fullContent = parts.join('\n');
  debugLog(
    logger,
    `[VfsResolver] Resolved essay session ${vfsRef.sourceId}: ${roundsToTake} rounds, ${fullContent.length} chars`,
  );
  return [textBlock(
    `<essay title="${escapeXmlAttr(displayTitle)}">${escapeXmlContent(fullContent)}</essay>`,
  )];
}

/** `resolve_translation`：resources.data 为 `{source,translated}` JSON。 */
export function resolveTranslation(
  db: SqlExecutor,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  const row = translationContentRow(db, vfsRef.sourceId);
  if (row === null || row.data === null) {
    debugLog(logger, `[VfsResolver] Translation has no content: ${vfsRef.sourceId}`);
    return [];
  }
  const title = row.title ?? vfsRef.name;
  let json: unknown;
  try {
    json = JSON.parse(row.data);
  } catch (error) {
    logger.warn(
      `[VfsResolver] Failed to parse translation JSON ${vfsRef.sourceId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [textBlock(
      `<translation title="${escapeXmlAttr(title)}">${escapeXmlContent(row.data)}</translation>`,
    )];
  }
  const record = typeof json === 'object' && json !== null ? json as Record<string, unknown> : {};
  const source = typeof record.source === 'string' ? record.source : '';
  const translated = typeof record.translated === 'string' ? record.translated : '';

  let content = '';
  if (source !== '') content += `<original>\n${escapeXmlContent(source)}\n</original>\n`;
  if (translated !== '') content += `<translated>\n${escapeXmlContent(translated)}\n</translated>`;

  if (content === '') {
    debugLog(logger, `[VfsResolver] Translation has empty source/translated: ${vfsRef.sourceId}`);
    return [];
  }
  debugLog(logger, `[VfsResolver] Resolved translation ${vfsRef.sourceId}: ${content.length} chars`);
  return [textBlock(
    `<translation title="${escapeXmlAttr(title)}">\n${content}\n</translation>`,
  )];
}

const MAX_MINDMAP_OUTLINE_DEPTH = 100;
const MAX_MINDMAP_OUTLINE_NODES = 10000;

/** `extract_mindmap_outline`：迭代遍历，带深度/节点数上限。 */
export function extractMindmapOutline(root: unknown): string {
  let output = '';
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  let visited = 0;
  let truncated = false;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    const { node, depth } = entry;
    if (depth > MAX_MINDMAP_OUTLINE_DEPTH) {
      truncated = true;
      continue;
    }
    visited += 1;
    if (visited > MAX_MINDMAP_OUTLINE_NODES) {
      truncated = true;
      break;
    }
    const record = typeof node === 'object' && node !== null ? node as Record<string, unknown> : {};
    if (typeof record.text === 'string') {
      output += '  '.repeat(depth);
      output += depth === 0 ? '# ' : '- ';
      output += record.text;
      output += '\n';
    }
    const children = record.children;
    if (Array.isArray(children)) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index], depth: depth + 1 });
      }
    }
  }

  if (truncated) output += '[outline truncated]\n';
  return output;
}

/** `resolve_mindmap`：MindMapDocument JSON 转树形大纲文本。 */
export function resolveMindmap(
  db: SqlExecutor,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  const result = mindmapContentRow(db, vfsRef.sourceId);
  if (result.kind === 'error') {
    debugLog(logger, `[VfsResolver] MindMap not found ${vfsRef.sourceId}: ${result.message}`);
    return [textBlock(`[知识导图未找到: ${vfsRef.name}]`)];
  }
  if (result.kind === 'notFound') {
    debugLog(logger, `[VfsResolver] MindMap not found ${vfsRef.sourceId}`);
    return [textBlock(`[知识导图未找到: ${vfsRef.name}]`)];
  }
  const { row } = result;
  if (row.data === null) {
    debugLog(logger, `[VfsResolver] MindMap has no content: ${vfsRef.sourceId}`);
    return [];
  }

  const title = row.title ?? vfsRef.name;
  let outlineText: string;
  try {
    const json = JSON.parse(row.data) as Record<string, unknown>;
    const root = json.root;
    const outline = root === undefined ? '' : extractMindmapOutline(root);
    outlineText = outline === '' ? row.data : outline;
  } catch (error) {
    outlineText = row.data;
  }

  let content = '';
  if (row.description !== null && rustTrim(row.description) !== '') {
    content += `<description>${escapeXmlContent(row.description)}</description>\n`;
  }
  content += `<outline>\n${escapeXmlContent(outlineText)}</outline>`;

  debugLog(logger, `[VfsResolver] Resolved mindmap ${vfsRef.sourceId}: ${content.length} chars`);
  return [textBlock(
    `<mindmap title="${escapeXmlAttr(title)}">\n${content}\n</mindmap>`,
  )];
}

/** `resolve_insight_card`：当前修订正文快照。 */
export function resolveInsightCard(
  db: SqlExecutor,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  const row = insightCardContentRow(db, vfsRef.sourceId);
  if (row === null || row.data === null) {
    debugLog(logger, `[VfsResolver] Insight card not found: ${vfsRef.sourceId}`);
    return [];
  }
  const title = row.title ?? vfsRef.name;
  return [textBlock(
    `<insight_card title="${escapeXmlAttr(title)}">${escapeXmlContent(row.data)}</insight_card>`,
  )];
}
