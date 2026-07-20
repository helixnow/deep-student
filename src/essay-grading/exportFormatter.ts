import i18next from 'i18next';
import {
  parseStreamingContent,
  type StreamingMarker,
  type ParsedScore,
  type PolishItem
} from './streamingMarkerParser';

function et(key: string, options?: Record<string, unknown>): string {
  return i18next.t(`essay_grading:export.${key}`, options as any) as string;
}

/** 剥离文案中的 Markdown 装饰（### 标题、**加粗**），供纯文本/HTML 导出复用同一批 i18n key */
function stripMarkdownDecoration(text: string): string {
  return text
    .replace(/^#{1,6}\s*/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
}

/** 取导出文案并剥离 Markdown 装饰 */
function etPlain(key: string, options?: Record<string, unknown>): string {
  return stripMarkdownDecoration(et(key, options));
}

/** 错误类型本地化：essay_grading:markers.error.{type}，缺失翻译时回退原始代码 */
function errorTypeLabel(type?: string): string {
  if (!type) return '';
  return i18next.t(`essay_grading:markers.error.${type}`, { defaultValue: type }) as string;
}

/** 等级本地化：essay_grading:score.grade.{code}，缺失翻译时回退大写代码 */
function gradeLabel(grade: string): string {
  return i18next.t(`essay_grading:score.grade.${grade}`, { defaultValue: grade.toUpperCase() }) as string;
}

/** 数据层专属导出文案（essay_grading:data_layer.export.*） */
function edl(key: string): string {
  return i18next.t(`essay_grading:data_layer.export.${key}`) as string;
}

/** Markdown 表格单元格转义：竖线与换行会破坏表格结构 */
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 标记类型的本地化标签（复用 markers.* 既有 key） */
function markerTypeLabel(type: StreamingMarker['type']): string {
  const keyMap: Partial<Record<StreamingMarker['type'], string>> = {
    del: 'essay_grading:markers.delete',
    ins: 'essay_grading:markers.insert',
    replace: 'essay_grading:markers.replace',
    note: 'essay_grading:markers.note',
    good: 'essay_grading:markers.good',
  };
  const key = keyMap[type];
  return key ? (i18next.t(key) as string) : '';
}

/** 逐句对照条目（del/replace/err/ins/note/good），空数组表示无可列条目 */
interface CorrectionItem {
  label: string;
  body: string;
}

function collectCorrectionItems(markers: StreamingMarker[]): CorrectionItem[] {
  const items: CorrectionItem[] = [];
  const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
  for (const marker of markers) {
    switch (marker.type) {
      case 'del':
        items.push({
          label: markerTypeLabel('del'),
          body: `${oneLine(marker.content)}${marker.reason ? `（${oneLine(marker.reason)}）` : ''}`,
        });
        break;
      case 'ins':
        items.push({ label: markerTypeLabel('ins'), body: oneLine(marker.content) });
        break;
      case 'replace':
        items.push({
          label: markerTypeLabel('replace'),
          body: `${oneLine(marker.oldText ?? '')} → ${oneLine(marker.newText ?? '')}${marker.reason ? `（${oneLine(marker.reason)}）` : ''}`,
        });
        break;
      case 'err': {
        const label = errorTypeLabel(marker.errorType) || markerTypeLabel('note');
        items.push({
          label,
          body: `${oneLine(marker.content)}${marker.explanation ? ` — ${oneLine(marker.explanation)}` : ''}`,
        });
        break;
      }
      case 'note':
        items.push({
          label: markerTypeLabel('note'),
          body: `${oneLine(marker.content)}${marker.comment ? ` — ${oneLine(marker.comment)}` : ''}`,
        });
        break;
      case 'good':
        items.push({ label: markerTypeLabel('good'), body: oneLine(marker.content) });
        break;
      default:
        break;
    }
  }
  return items.filter((item) => item.body.length > 0);
}

/** 导出选项 */
export interface ExportFormatOptions {
  /**
   * 是否在导出内容中附带「原文」章节（使用 originalInput）。
   * 默认 false：现有调用方（EssayGradingWorkbench）已自行输出原文章节，避免重复。
   */
  includeOriginal?: boolean;
}

/**
 * 将带 XML 标记的批改结果转换为用户友好的 Markdown 格式
 * 用于导出文件或复制到剪贴板
 */
export function formatGradingResultForExport(
  rawContent: string, 
  originalInput: string,
  options?: ExportFormatOptions
): string {
  let markdown = '';

  // 0. 原文部分（可选）
  if (options?.includeOriginal && originalInput.trim()) {
    markdown += et('original_text') + '\n\n';
    markdown += originalInput.trim();
    markdown += '\n\n---\n\n';
  }

  // 空结果兜底：无批改内容时输出占位说明，不产出空章节
  if (!rawContent.trim()) {
    return markdown + edl('empty_result') + '\n';
  }

  // 复用现有的解析器逻辑获取结构化数据
  // 第二个参数 true 表示认为流式已结束，处理所有剩余文本
  const parsed = parseStreamingContent(rawContent, true);

  // 1. 评分部分
  if (parsed.score) {
    markdown += formatScore(parsed.score);
    markdown += '\n\n---\n\n';
  }

  // 2. 批注详情部分（将行内标记转换为可读文本）
  markdown += et('grading_details') + '\n\n';
  markdown += formatMarkersToMarkdown(parsed.markers).trim() || edl('empty_result');
  markdown += '\n\n';

  // 3. 逐句修改对照（del/replace/err 等结构化条目清单）
  const corrections = collectCorrectionItems(parsed.markers);
  if (corrections.length > 0) {
    markdown += '---\n\n' + edl('corrections_title') + '\n\n';
    markdown += corrections
      .map((item, index) => `${index + 1}. **${item.label}**：${item.body}`)
      .join('\n');
    markdown += '\n\n';
  }

  // 4. 润色部分
  if (parsed.polishItems.length > 0) {
    markdown += '---\n\n' + et('polish_suggestions') + '\n\n';
    markdown += formatPolishItems(parsed.polishItems);
    markdown += '\n\n';
  }

  // 5. 范文部分
  if (parsed.modelEssay) {
    markdown += '---\n\n' + et('model_essay') + '\n\n';
    markdown += parsed.modelEssay;
    markdown += '\n';
  }

  return markdown;
}

function formatScore(score: ParsedScore): string {
  let md = et('score_title', { total: score.total, max: score.maxTotal, grade: gradeLabel(score.grade) }) + '\n\n';
  
  if (score.dimensions.length > 0) {
    md += et('table_header') + '\n';
    md += et('table_separator') + '\n';
    score.dimensions.forEach(dim => {
      const comment = dim.comment ? escapeTableCell(dim.comment) : '-';
      md += `| ${escapeTableCell(dim.name)} | ${dim.score} | ${dim.maxScore} | ${comment} |\n`;
    });
  }
  
  return md;
}

function formatMarkersToMarkdown(markers: StreamingMarker[]): string {
  return markers.map(marker => {
    switch (marker.type) {
      case 'text':
        return marker.content;
      
      case 'del': {
        // 删除：~~text~~
        const delReason = marker.reason ? ` (${et('delete_reason')}${marker.reason})` : '';
        return `~~${marker.content}~~${delReason}`;
      }

      case 'ins':
        // 插入：**text**
        return `**${marker.content}**`;

      case 'replace': {
        // 替换：~~old~~ -> **new**
        const replaceReason = marker.reason ? ` (${marker.reason})` : '';
        return `~~${marker.oldText ?? ''}~~ → **${marker.newText ?? ''}**${replaceReason}`;
      }

      case 'err': {
        // 错误：text (错误: explanation)
        const errInfo = [];
        if (marker.errorType) errInfo.push(errorTypeLabel(marker.errorType));
        if (marker.explanation) errInfo.push(marker.explanation);
        const errDesc = errInfo.length > 0 ? `(❌ ${errInfo.join(': ')})` : '';
        return `${marker.content}${errDesc}`;
      }
      
      case 'note':
        // 批注：text (注: comment)
        return marker.comment ? `${marker.content} (📝 ${marker.comment})` : marker.content;
      
      case 'good':
        // 优秀：**text** (✨)
        return `**${marker.content}** (✨)`;
      
      case 'pending':
        return marker.content;
        
      default:
        return marker.content;
    }
  }).join('');
}

function formatPolishItems(items: PolishItem[]): string {
  return items.map((item, index) => {
    return `${et('original_sentence', { index: index + 1 })}${item.original}\n\n` + 
           `   ${et('polished_sentence')}${item.polished}\n`;
  }).join('\n');
}

// ============================================================================
// 纯文本导出（复制到剪贴板用）
// ============================================================================

/**
 * 将批改结果转换为不含 Markdown/XML 语法的纯文本。
 * 用途：复制到剪贴板、粘贴进不支持富文本的目标（聊天框、纯文本编辑器等）。
 */
export function formatGradingResultAsPlainText(
  rawContent: string,
  originalInput: string,
  options?: ExportFormatOptions
): string {
  const divider = '----------------------------------------';
  const sections: string[] = [];

  if (options?.includeOriginal && originalInput.trim()) {
    sections.push(`${etPlain('original_text')}\n\n${originalInput.trim()}`);
  }

  if (!rawContent.trim()) {
    sections.push(edl('empty_result'));
    return sections.join(`\n\n${divider}\n\n`) + '\n';
  }

  const parsed = parseStreamingContent(rawContent, true);

  if (parsed.score) {
    sections.push(formatScoreAsPlainText(parsed.score));
  }

  sections.push(`${etPlain('grading_details')}\n\n${formatMarkersToPlainText(parsed.markers).trim() || edl('empty_result')}`);

  const corrections = collectCorrectionItems(parsed.markers);
  if (corrections.length > 0) {
    const lines = corrections
      .map((item, index) => `${index + 1}. [${item.label}] ${item.body}`)
      .join('\n');
    sections.push(`${stripMarkdownDecoration(edl('corrections_title'))}\n\n${lines}`);
  }

  if (parsed.polishItems.length > 0) {
    const items = parsed.polishItems.map((item, index) =>
      `${etPlain('original_sentence', { index: index + 1 })}${item.original}\n${etPlain('polished_sentence')}${item.polished}`
    ).join('\n\n');
    sections.push(`${etPlain('polish_suggestions')}\n\n${items}`);
  }

  if (parsed.modelEssay) {
    sections.push(`${etPlain('model_essay')}\n\n${parsed.modelEssay}`);
  }

  return sections.join(`\n\n${divider}\n\n`) + '\n';
}

function formatScoreAsPlainText(score: ParsedScore): string {
  const lines = [etPlain('score_title', { total: score.total, max: score.maxTotal, grade: gradeLabel(score.grade) })];
  score.dimensions.forEach(dim => {
    const comment = dim.comment ? ` — ${dim.comment.replace(/\n/g, ' ')}` : '';
    lines.push(`${dim.name}: ${dim.score}/${dim.maxScore}${comment}`);
  });
  return lines.join('\n');
}

function formatMarkersToPlainText(markers: StreamingMarker[]): string {
  return markers.map(marker => {
    switch (marker.type) {
      case 'del': {
        const delReason = marker.reason ? `(${etPlain('delete_reason')}${marker.reason})` : '';
        return `${marker.content}${delReason}`;
      }
      case 'ins':
        return marker.content;
      case 'replace': {
        const replaceReason = marker.reason ? ` (${marker.reason})` : '';
        return `${marker.oldText ?? ''} → ${marker.newText ?? ''}${replaceReason}`;
      }
      case 'err': {
        const errInfo = [];
        if (marker.errorType) errInfo.push(errorTypeLabel(marker.errorType));
        if (marker.explanation) errInfo.push(marker.explanation);
        return errInfo.length > 0 ? `${marker.content}(${errInfo.join(': ')})` : marker.content;
      }
      case 'note':
        return marker.comment ? `${marker.content} (${marker.comment})` : marker.content;
      case 'good':
      case 'text':
      case 'pending':
      default:
        return marker.content;
    }
  }).join('');
}

// ============================================================================
// HTML 导出（带内联样式的批注颜色，供打印/分享）
// ============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 换行转 <br>，内容已转义 */
function nl2br(escaped: string): string {
  return escaped.replace(/\n/g, '<br>');
}

const HTML_STYLES = {
  del: 'color:#dc2626;text-decoration:line-through;text-decoration-color:rgba(248,113,113,0.7);',
  ins: 'color:#059669;text-decoration:underline;text-decoration-color:rgba(52,211,153,0.7);',
  replaceOld: 'color:#dc2626;text-decoration:line-through;',
  replaceNew: 'color:#059669;',
  note: 'color:#2563eb;border-bottom:1px dashed #60a5fa;',
  good: 'color:#b45309;background:#fef3c7;border-radius:2px;padding:0 2px;',
  err: 'color:#dc2626;text-decoration:underline wavy;text-decoration-color:rgba(248,113,113,0.6);text-underline-offset:4px;',
  heading: 'font-size:18px;font-weight:600;margin:24px 0 12px;',
  tableCell: 'border:1px solid #d1d5db;padding:6px 10px;text-align:left;',
} as const;

/**
 * 将批改结果转换为带内联样式的自包含 HTML 文档。
 * 用途：打印、分享、在浏览器/邮件中查看（批注颜色与应用内批注视图一致）。
 */
export function formatGradingResultAsHtml(
  rawContent: string,
  originalInput: string,
  options?: ExportFormatOptions
): string {
  const body: string[] = [];

  if (options?.includeOriginal && originalInput.trim()) {
    body.push(htmlHeading(etPlain('original_text')));
    body.push(`<p style="white-space:pre-wrap;">${escapeHtml(originalInput.trim())}</p>`);
  }

  if (!rawContent.trim()) {
    body.push(`<p style="color:#6b7280;">${escapeHtml(edl('empty_result'))}</p>`);
    return wrapHtmlDocument(body);
  }

  const parsed = parseStreamingContent(rawContent, true);

  if (parsed.score) {
    body.push(formatScoreAsHtml(parsed.score));
  }

  body.push(htmlHeading(etPlain('grading_details')));
  body.push(`<p style="line-height:1.9;">${formatMarkersToHtml(parsed.markers)}</p>`);

  if (parsed.polishItems.length > 0) {
    body.push(htmlHeading(etPlain('polish_suggestions')));
    body.push(formatPolishItemsAsHtml(parsed.polishItems));
  }

  if (parsed.modelEssay) {
    body.push(htmlHeading(etPlain('model_essay')));
    body.push(`<p style="white-space:pre-wrap;">${escapeHtml(parsed.modelEssay)}</p>`);
  }

  return wrapHtmlDocument(body);
}

function wrapHtmlDocument(body: string[]): string {
  const title = escapeHtml(i18next.t('essay_grading:page_title') as string);
  return [
    '<!DOCTYPE html>',
    '<html>',
    `<head><meta charset="utf-8"><title>${title}</title></head>`,
    '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#1f2328;max-width:720px;margin:0 auto;padding:32px 24px;font-size:15px;">',
    ...body,
    '</body>',
    '</html>',
  ].join('\n');
}

function htmlHeading(text: string): string {
  return `<h2 style="${HTML_STYLES.heading}">${escapeHtml(text)}</h2>`;
}

function formatScoreAsHtml(score: ParsedScore): string {
  const parts: string[] = [];
  parts.push(htmlHeading(etPlain('score_title', { total: score.total, max: score.maxTotal, grade: gradeLabel(score.grade) })));

  if (score.dimensions.length > 0) {
    // 复用 Markdown 表头 i18n key（"| 维度 | 得分 | 满分 | 评语 |"）拆出列名
    const headers = etPlain('table_header').split('|').map(s => s.trim()).filter(Boolean);
    const headerRow = headers.map(h => `<th style="${HTML_STYLES.tableCell}background:#f3f4f6;">${escapeHtml(h)}</th>`).join('');
    const bodyRows = score.dimensions.map(dim => {
      const comment = dim.comment ? dim.comment.replace(/\n/g, ' ') : '-';
      return `<tr>` +
        `<td style="${HTML_STYLES.tableCell}">${escapeHtml(dim.name)}</td>` +
        `<td style="${HTML_STYLES.tableCell}">${dim.score}</td>` +
        `<td style="${HTML_STYLES.tableCell}">${dim.maxScore}</td>` +
        `<td style="${HTML_STYLES.tableCell}">${escapeHtml(comment)}</td>` +
        `</tr>`;
    }).join('');
    parts.push(`<table style="border-collapse:collapse;margin:8px 0;"><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`);
  }

  return parts.join('\n');
}

function formatMarkersToHtml(markers: StreamingMarker[]): string {
  return markers.map(marker => {
    const content = escapeHtml(marker.content ?? '');
    switch (marker.type) {
      case 'del': {
        const title = marker.reason ? ` title="${escapeHtml(marker.reason)}"` : '';
        return `<del style="${HTML_STYLES.del}"${title}>${content}</del>`;
      }
      case 'ins':
        return `<ins style="${HTML_STYLES.ins}">${content}</ins>`;
      case 'replace': {
        const title = marker.reason ? ` title="${escapeHtml(marker.reason)}"` : '';
        return `<span${title}>` +
          `<del style="${HTML_STYLES.replaceOld}">${escapeHtml(marker.oldText ?? '')}</del>` +
          `<span style="color:#9ca3af;"> → </span>` +
          `<span style="${HTML_STYLES.replaceNew}">${escapeHtml(marker.newText ?? '')}</span>` +
          `</span>`;
      }
      case 'note': {
        const title = marker.comment ? ` title="${escapeHtml(marker.comment)}"` : '';
        return `<span style="${HTML_STYLES.note}"${title}>${content}</span>`;
      }
      case 'good':
        return `<span style="${HTML_STYLES.good}">${content}</span>`;
      case 'err': {
        const errInfo = [];
        if (marker.errorType) errInfo.push(errorTypeLabel(marker.errorType));
        if (marker.explanation) errInfo.push(marker.explanation);
        const title = errInfo.length > 0 ? ` title="${escapeHtml(errInfo.join(': '))}"` : '';
        return `<span style="${HTML_STYLES.err}"${title}>${content}</span>`;
      }
      case 'text':
      case 'pending':
      default:
        return nl2br(content);
    }
  }).join('');
}

function formatPolishItemsAsHtml(items: PolishItem[]): string {
  const rows = items.map((item, index) => {
    return `<li style="margin-bottom:12px;">` +
      `<div>${escapeHtml(etPlain('original_sentence', { index: index + 1 }))}${escapeHtml(item.original)}</div>` +
      `<div style="color:#059669;">${escapeHtml(etPlain('polished_sentence'))}${escapeHtml(item.polished)}</div>` +
      `</li>`;
  }).join('');
  return `<ul style="list-style:none;padding:0;margin:0;">${rows}</ul>`;
}
