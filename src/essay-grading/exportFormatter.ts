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

/**
 * 将带 XML 标记的批改结果转换为用户友好的 Markdown 格式
 * 用于导出文件或复制到剪贴板
 */
export function formatGradingResultForExport(
  rawContent: string, 
  originalInput: string
): string {
  // 复用现有的解析器逻辑获取结构化数据
  // 第二个参数 true 表示认为流式已结束，处理所有剩余文本
  const parsed = parseStreamingContent(rawContent, true);
  
  let markdown = '';

  // 1. 评分部分
  if (parsed.score) {
    markdown += formatScore(parsed.score);
    markdown += '\n\n---\n\n';
  }

  // 2. 批注详情部分（将行内标记转换为可读文本）
  markdown += et('grading_details') + '\n\n';
  markdown += formatMarkersToMarkdown(parsed.markers);
  markdown += '\n\n';

  // 3. 润色部分
  if (parsed.polishItems.length > 0) {
    markdown += '---\n\n' + et('polish_suggestions') + '\n\n';
    markdown += formatPolishItems(parsed.polishItems);
    markdown += '\n\n';
  }

  // 4. 范文部分
  if (parsed.modelEssay) {
    markdown += '---\n\n' + et('model_essay') + '\n\n';
    markdown += parsed.modelEssay;
    markdown += '\n';
  }

  return markdown;
}

function formatScore(score: ParsedScore): string {
  let md = et('score_title', { total: score.total, max: score.maxTotal, grade: score.grade.toUpperCase() }) + '\n\n';
  
  if (score.dimensions.length > 0) {
    md += et('table_header') + '\n';
    md += '| :--- | :--- | :--- | :--- |\n';
    score.dimensions.forEach(dim => {
      const comment = dim.comment ? dim.comment.replace(/\n/g, ' ') : '-';
      md += `| ${dim.name} | ${dim.score} | ${dim.maxScore} | ${comment} |\n`;
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
        const delReason = marker.reason ? `^${et('delete_reason')}${marker.reason}` : '';
        return `~~${marker.content}~~${delReason ? `(${delReason})` : ''}`;
      }

      case 'ins':
        // 插入：**text**
        return `**${marker.content}**`;

      case 'replace': {
        // 替换：~~old~~ -> **new**
        const replaceReason = marker.reason ? ` (${marker.reason})` : '';
        return `~~${marker.oldText}~~ → **${marker.newText}**${replaceReason}`;
      }

      case 'err': {
        // 错误：text (错误: explanation)
        const errInfo = [];
        if (marker.errorType) errInfo.push(marker.errorType);
        if (marker.explanation) errInfo.push(marker.explanation);
        const errDesc = errInfo.length > 0 ? `(❌ ${errInfo.join(': ')})` : '';
        return `${marker.content}${errDesc}`;
      }
      
      case 'note':
        // 批注：text (注: comment)
        return `${marker.content} (📝 ${marker.comment})`;
      
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
