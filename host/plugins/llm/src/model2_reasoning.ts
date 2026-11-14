/** parser.rs:36–229, used by the unified-stream output (not a second provider parser). */
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';

export function extractReasoningSections(content: string): JsonValue[] {
  // These fixed patterns use Rust Unicode White_Space and Nd; anchors deliberately lack m.
  const patterns = [
    /^#{1,4}\p{White_Space}*(步骤\p{White_Space}*\p{Nd}+|问题理解|知识点分析|解题思路|具体步骤|结论总结)[:：]?\p{White_Space}*(.*)$(?![\s\S])/iu,
    /^(\p{Nd}+\.\p{White_Space}*(?:问题理解|知识点分析|解题思路|具体步骤|结论总结))[:：]?\p{White_Space}*(.*)$(?![\s\S])/iu,
    /^(思考过程\p{White_Space}*\p{Nd}*|分析\p{White_Space}*\p{Nd}*|推理\p{White_Space}*\p{Nd}*)[:：]\p{White_Space}*(.*)$(?![\s\S])/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match) return [{ title: rustTrim(match[1] ?? '未知段落'), content: rustTrim(match[2] ?? ''), section_index: 0, extraction_method: 'regex' }];
  }
  const keywords = ['思考过程', '分析过程', '推理过程', '解题思路', '问题理解', '知识点分析', '具体步骤', '结论总结',
    '答案推导', '计算过程', '观察', '假设', '验证', '解法', '方法', '策略', '思维链', '第一步', '第二步', '第三步', '最后', '因此', '所以', '综上'];
  const sections: JsonValue[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const finish = (): void => {
    if (current?.lines.length) sections.push({ title: current.title, content: current.lines.join('\n'), extraction_method: 'keyword_sections' });
  };
  for (const line of content.split('\n')) {
    const trimmed = rustTrim(line);
    if (!trimmed) continue;
    const title = keywords.some(keyword => trimmed.startsWith(keyword) || trimmed.includes(keyword)
      && (trimmed.endsWith('：') || trimmed.endsWith(':') || utf8ByteLength(trimmed) < 50
        && ['分析', '思考', '步骤'].some(word => trimmed.includes(word))));
    if (title) { finish(); current = { title: trimmed.replace(/[:：]+$/u, ''), lines: [] }; }
    else current?.lines.push(trimmed);
  }
  finish();
  if (sections.length) return sections;
  const trimmed = rustTrim(content);
  if (!trimmed) return [];
  const sentences = trimmed.split(/[。.\n]/u).map(rustTrim).filter(text => utf8ByteLength(text) > 10);
  if (sentences.length <= 1) return [{ title: '完整推理内容', content: trimmed, section_index: 0, extraction_method: 'full_content_fallback' }];
  for (let i = 0; i < sentences.length; i += 2) sections.push({ title: `思维片段 ${i / 2 + 1}`,
    content: sentences.slice(i, i + 2).join('。'), section_index: i / 2, extraction_method: 'semantic_fallback' });
  return sections;
}
