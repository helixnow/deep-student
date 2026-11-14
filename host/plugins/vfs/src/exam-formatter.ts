/** dstu/exam_formatter.rs: canonical context first, otherwise preview XML/image blocks. */
import { CommandError } from '../../../kernel/api.ts';
import type { ContentBlock, VfsDatabase } from '../api.ts';
import { vfsRepositories } from '../repository/services.ts';
import { contextWithConn, imageRefs } from '../repository/qbank-read.ts';
import { parseExamPreview, type ExamCard, type ExamPreview } from './exam-preview.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { fs } from './local-runtime.ts';

interface ExamFormatterDeps {
  database: VfsDatabase;
  log: { warn(message: string, ...args: unknown[]): void; info(message: string, ...args: unknown[]): void };
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const text = (text: string): ContentBlock => ({ type: 'text', text });

export function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;').replaceAll('"', '&quot;');
}
function questionXml(card: ExamCard): string {
  const b = card.bbox;
  const bounds = [b.x, b.y, b.width, b.height].map(v => Math.fround(v).toFixed(3)).join(',');
  return `<question label='${escapeXml(card.question_label)}' bbox='${bounds}'>${escapeXml(card.ocr_text)}</question>`;
}
export function formatPageQuestions(cards: readonly ExamCard[]): string {
  return cards.map(card => `\n${questionXml(card)}`).join('');
}
function formatTextOnly(preview: ExamPreview): ContentBlock[] {
  let xml = `<attached_exam_sheet exam_name='${escapeXml(preview.exam_name ?? '未命名试卷')}'>\n`;
  for (const page of preview.pages) {
    xml += `  <page index='${page.page_index}'>\n`;
    for (const card of page.cards) xml += `    ${questionXml(card)}\n`;
    xml += '  </page>\n';
  }
  return [text(`${xml}</attached_exam_sheet>`)];
}
function blobImage(deps: ExamFormatterDeps, hash: string): ContentBlock {
  const repo = vfsRepositories().blobs;
  let blob;
  try { blob = repo.getBlob(deps.database.getConnSafe(), hash); }
  catch (error) { throw new Error(`获取 blob 元数据失败: ${message(error)}`); }
  if (blob === null) throw new Error(`Blob 不存在: ${hash}`);
  let file;
  try { file = repo.getBlobPath(deps.database.getConnSafe(), deps.database.blobsDir(), hash); }
  catch (error) { throw new Error(`获取 blob 路径失败: ${message(error)}`); }
  if (file === null) throw new Error(`Blob 文件路径不存在: ${hash}`);
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) { throw new Error(`读取 blob 文件失败: ${message(error)}`); }
  return { type: 'image', mediaType: blob.mimeType ?? 'image/jpeg', base64: toBase64(bytes) };
}

export function getExamContentCommand(deps: ExamFormatterDeps, examId: string, isMultimodal: boolean): ContentBlock[] {
  deps.log.info('[DSTU::handlers] dstu_get_exam_content: exam_id=%s, is_multimodal=%s', examId, isMultimodal);
  try {
    let exam;
    try { exam = vfsRepositories().exams.getExamSheet(deps.database.getConnSafe(), examId); }
    catch (error) { throw new Error(`获取题目集数据失败: ${message(error)}`); }
    if (exam === null) throw new Error(`题目集不存在: ${examId}`);
    const canonical = contextWithConn(deps.database.getConnSafe(), examId);
    if (canonical !== null) {
      const blocks = [text(`<attached_exam_sheet id='${escapeXml(examId)}'>\n${escapeXml(JSON.stringify(canonical))}\n</attached_exam_sheet>`)];
      if (isMultimodal) for (const image of imageRefs(canonical)) {
        try { blocks.push(blobImage(deps, image.hash as string)); }
        catch (error) { throw new Error(`题目/材料必要图片缺失: ${message(error)}`); }
      }
      return blocks;
    }
    let preview;
    try { preview = parseExamPreview(exam.previewJson); }
    catch (error) { throw new Error(`解析 preview_json 失败: ${message(error)}`); }
    if (!isMultimodal) return formatTextOnly(preview);
    // Rust intentionally does not XML-escape the multimodal exam_name attribute.
    const blocks = [text(`<attached_exam_sheet exam_name='${preview.exam_name ?? '未命名试卷'}'>`)];
    for (const page of preview.pages) {
      blocks.push(text(`\n<page index='${page.page_index}'>`));
      if (page.blob_hash !== null) {
        try { blocks.push(blobImage(deps, page.blob_hash)); }
        catch (error) {
          deps.log.warn('[exam_formatter] 获取页面 %s 图片失败: %s', page.page_index, message(error));
          blocks.push(text(`[页面 ${page.page_index} 图片加载失败]`));
        }
      } else if (page.original_image_path !== '') {
        blocks.push(text(`[页面 ${page.page_index} 图片使用旧存储格式，需要迁移]`));
      }
      const questions = formatPageQuestions(page.cards);
      if (questions !== '') blocks.push(text(questions));
      blocks.push(text('</page>'));
    }
    blocks.push(text('\n</attached_exam_sheet>'));
    return blocks;
  } catch (error) {
    throw new CommandError(message(error));
  }
}
