/**
 * 卡片字段里的聊天引用标记 → 可读文字。
 *
 * 聊天里制卡时模型会把回答里的引用标记原样抄进卡片字段（如词典卡「出处：[PDF@file_xxx:1]」），
 * 复习 / 预览 / 导出到 Anki 时显示成一串内部 ID。渲染时按聊天引用的同一组格式转换：
 * - [PDF@id:3] / [PDF@id:2-3] / [PDF@id:1,3] → 第 3 页 / 第 2-3 页 / 第 1、3 页
 * - [思维导图:mm_xxx:标题] / [题目集:id:名称] → 标题 / 名称（无标题则去掉）
 * - [知识库-1] / [搜索-2] / [记忆-1] / [图片-1] 等检索序号 → 去掉（离开对话就没有对应的来源列表）
 * 后端 APKG 导出（apkg_exporter_service.rs 的 humanize_citation_markers）按同一口径处理。
 */
const PDF_REF = /\[PDF@[A-Za-z0-9_-]+:\s*(\d+(?:[-,]\d+)*)\]/gi;
const PDF_BARE = /\[PDF@[A-Za-z0-9_-]+\]/gi;
const MINDMAP_REF = /\[(?:思维导图|导图|脑图|MindMap|mindmap):(?:mm_|mv_)[A-Za-z0-9_-]+(?:#[^:\]\n]+)?(?::([^\]]+))?\]/gi;
const QBANK_REF = /\[(?:题目集|题库|练习册|QuestionBank|question[_ ]?bank|qbank):[\w-]+(?::([^\]]+))?\]/gi;
const RETRIEVAL_REF = /\[(?:知识库|knowledge base|knowledge|记忆|memory|搜索|search|web|图片|image|灵感|insight)-\d+\]/gi;
const ANY_MARKER = /\[(?:PDF@|思维导图:|导图:|脑图:|MindMap:|mindmap:|题目集:|题库:|练习册:|QuestionBank:|question[_ ]?bank:|qbank:|知识库-|knowledge|记忆-|memory-|搜索-|search-|web-|图片-|image-|灵感-|insight-)/i;

export function humanizeCitationMarkers(text: string): string {
  if (!text || !ANY_MARKER.test(text)) return text;
  return text
    .replace(PDF_REF, (_m, pages: string) => `第 ${pages.replace(/,/g, '、')} 页`)
    .replace(PDF_BARE, '')
    .replace(MINDMAP_REF, (_m, title?: string) => title?.trim() ?? '')
    .replace(QBANK_REF, (_m, name?: string) => name?.trim() ?? '')
    .replace(RETRIEVAL_REF, '')
    // 标记删掉后留下的多余空格 / 句末分隔符
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；、,.;)）])/g, '$1')
    .replace(/[ \t]*[；;，,、]?[ \t]*$/gm, (tail) => (/[；;，,、]/.test(tail) && /\S/.test(tail) ? '' : tail.trimEnd()))
    .trimEnd();
}
