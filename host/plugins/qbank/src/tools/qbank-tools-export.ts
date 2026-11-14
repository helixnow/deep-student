/**
 * Paper and question-set export tools of qbank_executor.rs: `write_qbank_export` (1131),
 * `bounded_export_preview` (1183), `render_question_export_markdown/_docx` (1199/1237),
 * `execute_generate_paper` (4069) and `execute_export` (4384).
 */
import { with_localized_message, type JsonValue } from '../../../../platform/errors/api.ts';
import { encodeUtf8 } from '../../../../platform/util/portable.ts';
import type { GeneratedPaper, PaperConfig__De, PaperExportFormat, Question } from '../../api.ts';
import { rewritePaperDocument } from '../../repository/practice.ts';
import * as exportService from '../export-service.ts';
import * as practice from '../practice-service.ts';
import {
  asBool, asStr, errorText, optionalString, parseCountMap, parseDifficulty, parseStringArray, qbankFailure,
  questionToBoundedValue, readBool, readStrictU32, requiredNonEmptyString, truncateJsonStrings, tryParseStatus,
  type Args,
} from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';
import { decodeToolPreview, previewCards } from './qbank-tool-preview.ts';
import { executeGetStats, listAllQuestions } from './qbank-tools-questions.ts';

type JsonObject = Record<string, unknown>;

const PAPER_TYPE_KEYS = ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'true_false',
  'matching', 'ordering', 'numeric', 'short_answer', 'essay', 'calculation', 'proof', 'other'];
const EXPORT_FORMATS: readonly PaperExportFormat[] = ['preview', 'pdf', 'word', 'markdown'];

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** serde unit-variant enum: `"pdf"` or `{"pdf": null}`. */
function parseExportFormat(value: unknown): PaperExportFormat {
  if (typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value)) {
    return value as PaperExportFormat;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && (EXPORT_FORMATS as readonly string[]).includes(keys[0]!) && value[keys[0]!] === null) {
      return keys[0] as PaperExportFormat;
    }
  }
  throw qbankFailure('INVALID_ARGS', 'export_format 不受支持', '支持 preview、markdown、pdf 或 word');
}

/** qbank_executor.rs:4069 `execute_generate_paper`. */
export async function executeGeneratePaper(env: QbankToolEnv): Promise<unknown> {
  env.requireService();
  const { args, ctx } = env;
  const examId = requiredNonEmptyString(args, 'session_id');
  const source: Args = Object.hasOwn(args, 'config')
    ? (isObject(args.config) ? args.config : {})
    : args;
  const title = optionalString(source, 'title', 120) ?? '练习试卷';
  const typeSelection = parseCountMap(source.type_selection, 'type_selection', PAPER_TYPE_KEYS, 100);
  const requestedCount = readStrictU32(source, 'question_count', 20, 1, 100);
  let difficultyFilter: string[] | null = null;
  if (Object.hasOwn(source, 'difficulty_filter')) {
    difficultyFilter = parseStringArray(source.difficulty_filter, 'difficulty_filter', 4, 20);
    for (const difficulty of difficultyFilter) parseDifficulty(difficulty, 'difficulty_filter');
  }
  const tagsFilter = Object.hasOwn(source, 'tags_filter')
    ? parseStringArray(source.tags_filter, 'tags_filter', 20, 100) : null;
  const exportFormat = Object.hasOwn(source, 'export_format') ? parseExportFormat(source.export_format) : 'preview';
  const config: PaperConfig__De = {
    title, type_selection: typeSelection, difficulty_filter: difficultyFilter, tags_filter: tagsFilter,
    shuffle: readBool(source, 'shuffle', true),
    include_answers: readBool(source, 'include_answers', true),
    include_explanations: readBool(source, 'include_explanations', true),
    export_format: exportFormat,
  };
  let paper: GeneratedPaper;
  const host = await env.deps.practiceHost();
  try { paper = practice.generatePaper(host, examId, config); }
  catch (error) { throw new Error(errorText(error)); }
  if (Object.keys(typeSelection).length === 0 && paper.questions.length > requestedCount) {
    paper.questions = paper.questions.slice(0, requestedCount);
    paper.total_score = paper.questions.length;
    const { db } = env.vfs();
    try { rewritePaperDocument(db, paper); }
    catch (error) { throw new Error(errorText(error)); }
  }
  const fileCreated = exportFormat !== 'preview';
  if (fileCreated) {
    if (ctx.tryWindow() === null) {
      throw qbankFailure('QBANK_EXPORT_SURFACE_UNAVAILABLE', '试卷已保存，文件导出需要应用窗口', '在题目集试卷页导出已保存试卷');
    }
    const exported = await env.deps.exportPaper(paper, exportFormat, paper.config.include_answers,
      paper.config.include_explanations);
    if (!exported.ok) throw qbankFailure('QBANK_EXPORT_FAILED', exported.error, '试卷已保存，可在题目集的试卷页重新导出');
    paper.export_path = exported.value;
  }
  const previewCount = Math.min(paper.questions.length, 20);
  const questionPreviews = paper.questions.slice(0, previewCount).map(question => {
    const value = questionToBoundedValue(question);
    if (!paper.config.include_answers) value.answer = null;
    if (!paper.config.include_explanations) value.explanation = null;
    return value;
  });
  const [messageKey, zh, en] = fileCreated
    ? ['chat.tools.qbank.paper_markdown_created', '试卷已保存，导出文件已真实写入应用数据导出目录',
      'The paper was saved and its export file was written to the application export directory.']
    : ['chat.tools.qbank.paper_preview_created', '试卷已保存，可在题目集的试卷页打开；未导出文件',
      "The paper was saved to the question set's Papers page; no export file was created."];
  return with_localized_message({
    success: true, paper_id: paper.id, persisted: true, view: 'papers', grading_mode: 'on_submit',
    title: paper.title, session_id: paper.exam_id, total_score: paper.total_score,
    question_count: paper.questions.length, questions: questionPreviews as JsonValue,
    questions_truncated: previewCount < paper.questions.length, created_at: paper.created_at,
    export_format: paper.config.export_format, export_path: paper.export_path, file_created: fileCreated,
    requires_user_interaction: exportFormat === 'preview',
  }, messageKey, { fileCreated, format: exportFormat }, zh, en);
}

/** qbank_executor.rs:778 `safe_file_component`. */
function safeFileComponent(value: string): string {
  let result = '';
  let previousSeparator = false;
  for (const ch of [...value].slice(0, 80)) {
    if (/^[\p{Alphabetic}\p{N}]$/u.test(ch) || ch === '-' || ch === '_') {
      result += ch;
      previousSeparator = false;
    } else if (!previousSeparator) {
      result += '_';
      previousSeparator = true;
    }
  }
  const trimmed = result.replace(/^_+|_+$/gu, '');
  return trimmed === '' ? 'qbank-paper' : trimmed;
}

/** qbank_executor.rs:1131 `write_qbank_export`. */
async function writeQbankExport(env: QbankToolEnv, name: string, extension: string, bytes: Uint8Array): Promise<string> {
  const files = env.deps.files();
  if (files === null) {
    throw qbankFailure('QBANK_EXPORT_FAILED', '无法创建题库导出目录: 文件服务不可用', '检查应用数据目录权限后重试');
  }
  const appData = files.scope(env.deps.exportDir());
  const exportDir = 'exports/qbank';
  try { await appData.mkdir(exportDir, { recursive: true }); }
  catch (error) {
    throw qbankFailure('QBANK_EXPORT_FAILED', `无法创建题库导出目录: ${errorText(error)}`, '检查应用数据目录权限后重试');
  }
  const target = `${exportDir}/${safeFileComponent(name)}-${env.deps.crypto().randomUUID()}.${extension}`;
  const temporary = `${target}.tmp`;
  try { await appData.writeBytes(temporary, bytes); }
  catch (error) {
    throw qbankFailure('QBANK_EXPORT_FAILED', `写入题库导出文件失败: ${errorText(error)}`, '检查磁盘空间和应用数据目录权限后重试');
  }
  try { await appData.rename(temporary, target); }
  catch (error) {
    await appData.rm(temporary, { force: true }).catch(() => undefined);
    throw qbankFailure('QBANK_EXPORT_FAILED', `提交题库导出文件失败: ${errorText(error)}`, '检查应用数据目录权限后重试');
  }
  return appData.resolve(target);
}

/** qbank_executor.rs:1183 `bounded_export_preview`. */
function boundedExportPreview(questions: readonly JsonObject[]): unknown[] {
  return questions.slice(0, 20).map(question => {
    const value = structuredClone(question);
    const fieldsTruncated: string[] = [];
    truncateJsonStrings(value, '', fieldsTruncated);
    value.fieldsTruncated = fieldsTruncated;
    return value;
  });
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function materialsOf(question: JsonObject): JsonObject[] {
  return Array.isArray(question.materials) ? question.materials.filter(isObject) : [];
}

function optionsOf(question: JsonObject): unknown[] {
  return Array.isArray(question.options) ? question.options : [];
}

/** qbank_executor.rs:1199 `render_question_export_markdown`. */
export function renderQuestionExportMarkdown(name: string, questions: readonly JsonObject[]): string {
  let markdown = `# ${name}\n\n`;
  const seen = new Set<string>();
  questions.forEach((question, index) => {
    for (const material of materialsOf(question)) {
      const id = textOf(material.id);
      if (!seen.has(id)) {
        seen.add(id);
        markdown += `### 共享材料\n\n${textOf(material.content)}\n\n`;
      }
    }
    markdown += `## 题目 ${index + 1}\n\n`;
    markdown += `**题干**\n${textOf(question.content)}\n\n`;
    for (const option of optionsOf(question)) {
      const entry = isObject(option) ? option : {};
      markdown += `- ${textOf(entry.key)}. ${textOf(entry.content)}\n`;
    }
    if (typeof question.answer === 'string') markdown += `**答案**\n${question.answer}\n\n`;
    if (typeof question.explanation === 'string') markdown += `**解析**\n${question.explanation}\n\n`;
    markdown += '---\n\n';
  });
  return markdown;
}

/** qbank_executor.rs:1237 `render_question_export_docx` (spec only; bytes come from `DocumentParser`). */
export function questionExportDocxSpec(name: string, questions: readonly JsonObject[]): JsonObject {
  const blocks: JsonObject[] = [];
  const seen = new Set<string>();
  questions.forEach((question, index) => {
    for (const material of materialsOf(question)) {
      const id = textOf(material.id);
      if (!seen.has(id)) {
        seen.add(id);
        blocks.push({ type: 'paragraph', text: `共享材料：${textOf(material.content)}` });
      }
    }
    blocks.push({ type: 'heading', level: 2, text: `题目 ${index + 1}` });
    if (typeof question.content === 'string') blocks.push({ type: 'paragraph', text: question.content });
    for (const option of optionsOf(question)) {
      const entry = isObject(option) ? option : {};
      blocks.push({ type: 'paragraph', text: `${textOf(entry.key)}. ${textOf(entry.content)}` });
    }
    if (typeof question.answer === 'string') {
      blocks.push({ type: 'paragraph', text: `答案：${question.answer}`, bold: true });
    }
    if (typeof question.explanation === 'string') {
      blocks.push({ type: 'paragraph', text: `解析：${question.explanation}`, italic: true });
    }
  });
  return { title: name, blocks };
}

function formalExportRow(question: Question): JsonObject {
  return {
    label: question.question_label, content: question.content, question_type: question.question_type,
    options: question.options, answer: question.answer, explanation: question.explanation,
    structured_data: question.structured_data, difficulty: question.difficulty, tags: question.tags,
    status: question.status, attempt_count: question.attempt_count, correct_count: question.correct_count,
    user_note: question.user_note, images: question.images, materials: question.materials, group_id: question.group_id,
  };
}

/** qbank_executor.rs:4384 `execute_export`. */
export async function executeExport(env: QbankToolEnv): Promise<unknown> {
  const { args } = env;
  const sessionId = asStr(args.session_id);
  if (sessionId === null) throw new Error("Missing 'session_id' parameter");
  const format = asStr(args.format) ?? 'json';
  const includeStats = asBool(args.include_stats) ?? true;
  const filterStatus = asStr(args.filter_status);
  if (format !== 'json' && format !== 'markdown' && format !== 'docx') {
    throw qbankFailure('INVALID_ARGS', 'format 仅支持 json、markdown 或 docx', '修正导出格式后重试');
  }

  const service = env.service();
  let name: string;
  let rows: JsonObject[];
  let source: string;
  let degraded: boolean;
  if (service !== null) {
    let examName: string | null = null;
    const repos = env.deps.repos();
    if (repos !== null) {
      try { examName = repos.exams.getExamSheet(env.deps.db(), sessionId)?.examName ?? null; }
      catch { examName = null; }
    }
    name = examName ?? '题目集';
    const status = filterStatus === null ? null : tryParseStatus(filterStatus);
    rows = listAllQuestions(env, service, sessionId, status === null ? {} : { status: [status] }).map(formalExportRow);
    source = 'questions_table';
    degraded = false;
  } else {
    const { db, repos } = env.vfs();
    let exam;
    try { exam = repos.exams.getExamSheet(db, sessionId); }
    catch (error) { throw new Error(`Failed to get exam sheet: ${errorText(error)}`); }
    if (exam === null) throw new Error('Exam sheet not found');
    name = exam.examName ?? '题目集';
    let preview;
    try { preview = decodeToolPreview(exam.previewJson); }
    catch (error) { throw new Error(`Failed to parse preview: ${errorText(error)}`); }
    rows = previewCards(preview)
      .filter(card => filterStatus === null || card.status === filterStatus)
      .map(card => ({
        label: card.question_label, content: card.ocr_text, question_type: card.question_type ?? null,
        answer: card.answer ?? null, explanation: card.explanation ?? null, difficulty: card.difficulty ?? null,
        tags: card.tags, status: card.status, attempt_count: card.attempt_count, correct_count: card.correct_count,
        user_note: card.user_note ?? null,
      }));
    source = 'preview_json';
    degraded = true;
  }

  let extension: string;
  let bytes: Uint8Array;
  if (format === 'markdown') {
    extension = 'md';
    bytes = encodeUtf8(renderQuestionExportMarkdown(name, rows));
  } else if (format === 'docx') {
    extension = 'docx';
    const writer = env.deps.officeWriter();
    if (writer === null) throw new Error('DOCX 生成失败: nativeOfficeWriter 未提供');
    try { bytes = await writer.generateDocx(questionExportDocxSpec(name, rows)); }
    catch (error) { throw new Error(`DOCX 生成失败: ${errorText(error)}`); }
  } else {
    env.vfs();
    let document: unknown;
    try { document = exportService.document(env.deps.exportHost(), sessionId); }
    catch (error) {
      throw qbankFailure('QBANK_EXPORT_FAILED', `题目文档导出失败: ${errorText(error)}`, '重新读取题目集后导出');
    }
    extension = 'json';
    bytes = encodeUtf8(JSON.stringify(document, null, 2));
  }
  const exportPath = await writeQbankExport(env, name, extension, bytes);
  const result: JsonObject = {
    success: true, format, exportPath, fileSize: bytes.byteLength, questionCount: rows.length,
    questions: boundedExportPreview(rows), questionsTruncated: rows.length > 20, source, degraded, schemaVersion: 2,
  };
  if (includeStats) result.stats = executeGetStats(env);
  return result;
}
