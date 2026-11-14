/**
 * 题目导入调试：按会话追踪导入进度（各阶段时间点、计数、结束时的汇总），每 15 秒检查超过 3 分钟未结束的导入，
 * 并在模块加载时注册 question_import_progress 监听，把后端进度事件写成日志。
 */

import { pushImportLog } from './log';

// ============================================================================
// 会话追踪器
// ============================================================================

interface InflightImport {
  sessionId: string;
  startAt: number;
  sessionCreatedAt?: number;
  preprocessDoneAt?: number;
  ocrPhaseStartAt?: number;
  ocrPhaseDoneAt?: number;
  structuringStartAt?: number;
  completedAt?: number;
  failedAt?: number;
  totalImages: number;
  ocrImagesCompleted: number;
  totalChunks: number;
  chunksCompleted: number;
  totalParsed: number;
  lastPercent: number;
  warnedStuck?: boolean;
}

export const inflightImports = new Map<string, InflightImport>();
let currentImportKey = '';

function getOrCreateImport(sessionId: string): InflightImport {
  let s = inflightImports.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      startAt: Date.now(),
      totalImages: 0,
      ocrImagesCompleted: 0,
      totalChunks: 0,
      chunksCompleted: 0,
      totalParsed: 0,
      lastPercent: 0,
    };
    inflightImports.set(sessionId, s);
    currentImportKey = sessionId;
  }
  return s;
}

function emitImportSummary(s: InflightImport): void {
  const preprocessMs = s.preprocessDoneAt && s.startAt ? s.preprocessDoneAt - s.startAt : undefined;
  const ocrMs = s.ocrPhaseDoneAt && s.ocrPhaseStartAt ? s.ocrPhaseDoneAt - s.ocrPhaseStartAt : undefined;
  const structMs = s.completedAt && s.structuringStartAt ? s.completedAt - s.structuringStartAt : undefined;
  const totalMs = (s.completedAt || s.failedAt || Date.now()) - s.startAt;

  pushImportLog('info', 'system',
    `=== 导入汇总: ${s.sessionId.slice(0, 16)} | 图片=${s.ocrImagesCompleted}/${s.totalImages} 块=${s.chunksCompleted}/${s.totalChunks} 题目=${s.totalParsed} | 预处理=${preprocessMs ?? '?'}ms OCR=${ocrMs ?? '?'}ms 结构化=${structMs ?? '?'}ms 总耗时=${totalMs}ms ===`,
    {
      sessionId: s.sessionId,
      durationMs: totalMs,
      detail: {
        preprocessMs,
        ocrMs,
        structMs,
        totalMs,
        images: `${s.ocrImagesCompleted}/${s.totalImages}`,
        chunks: `${s.chunksCompleted}/${s.totalChunks}`,
        totalParsed: s.totalParsed,
        timestamps: {
          start: s.startAt,
          preprocessDone: s.preprocessDoneAt,
          ocrPhaseDone: s.ocrPhaseDoneAt,
          structuringStart: s.structuringStartAt,
          completed: s.completedAt,
          failed: s.failedAt,
        },
      },
    },
  );
}

// 定期检测卡住（3 分钟）
if (typeof window !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [, s] of inflightImports) {
      if (!s.completedAt && !s.failedAt && !s.warnedStuck && now - s.startAt > 180_000) {
        s.warnedStuck = true;
        pushImportLog('warn', 'anomaly:stuck',
          `导入 ${s.sessionId.slice(0, 16)} 已超过 3 分钟仍未完成 | 图片=${s.ocrImagesCompleted}/${s.totalImages} 块=${s.chunksCompleted}/${s.totalChunks} 题目=${s.totalParsed}`,
          { sessionId: s.sessionId, durationMs: now - s.startAt },
        );
      }
    }
  }, 15_000);
}

// ============================================================================
// Tauri 事件监听（模块加载时即注册）
// ============================================================================

let tauriListenerAttached = false;

async function attachTauriListener(): Promise<void> {
  if (tauriListenerAttached) return;
  tauriListenerAttached = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<Record<string, any>>('question_import_progress', ({ payload }) => {
      if (!payload) return;
      const type = payload.type as string;
      const sessionId = payload.session_id || currentImportKey || '?';

      switch (type) {
        case 'Preprocessing': {
          const s = getOrCreateImport(sessionId);
          const stage = payload.stage || '';
          const message = payload.message || '';
          const pct = payload.percent ?? 0;
          s.lastPercent = Math.max(s.lastPercent, pct);
          if (stage === 'creating_session') {
            s.preprocessDoneAt = Date.now();
          }
          pushImportLog('info', 'backend:preprocessing',
            `[${stage}] ${message} (${pct}%)`,
            { sessionId, percent: pct, detail: { stage, message } },
          );
          break;
        }
        case 'RenderingPages': {
          const s = getOrCreateImport(sessionId);
          const current = payload.current ?? 0;
          const total = payload.total ?? 0;
          pushImportLog('info', 'backend:rendering-pages',
            `渲染页面 ${current}/${total}`,
            { sessionId, detail: { current, total } },
          );
          break;
        }
        case 'OcrImageCompleted': {
          const s = getOrCreateImport(sessionId);
          const idx = (payload.image_index ?? 0) + 1;
          const total = payload.total_images ?? 0;
          s.ocrImagesCompleted = idx;
          s.totalImages = total;
          if (!s.ocrPhaseStartAt) s.ocrPhaseStartAt = Date.now();
          pushImportLog('info', 'backend:ocr-image',
            `VLM/OCR 图片 ${idx}/${total} 完成`,
            { sessionId, detail: { image_index: payload.image_index, total_images: total } },
          );
          break;
        }
        case 'OcrPhaseCompleted': {
          const s = getOrCreateImport(sessionId);
          s.ocrPhaseDoneAt = Date.now();
          const ocrMs = s.ocrPhaseStartAt ? s.ocrPhaseDoneAt - s.ocrPhaseStartAt : undefined;
          pushImportLog('success', 'backend:ocr-phase-done',
            `VLM/OCR 阶段完成: ${payload.total_images} 张图片, ${payload.total_chars} 字符 | 耗时 ${ocrMs ?? '?'}ms`,
            { sessionId, durationMs: ocrMs, detail: { total_images: payload.total_images, total_chars: payload.total_chars } },
          );
          break;
        }
        case 'ExtractingFigures': {
          const s = getOrCreateImport(sessionId);
          pushImportLog('info', 'backend:extracting-figs',
            `配图提取 ${payload.current}/${payload.total}`,
            { sessionId, detail: { current: payload.current, total: payload.total } },
          );
          break;
        }
        case 'StructuringQuestion': {
          const s = getOrCreateImport(sessionId);
          if (!s.structuringStartAt) s.structuringStartAt = Date.now();
          pushImportLog('info', 'backend:structuring',
            `LLM 结构化 ${payload.current}/${payload.total}`,
            { sessionId, detail: { current: payload.current, total: payload.total } },
          );
          break;
        }
        case 'SessionCreated': {
          const s = getOrCreateImport(payload.session_id || sessionId);
          s.sessionCreatedAt = Date.now();
          s.totalChunks = payload.total_chunks ?? 0;
          if (payload.session_id) currentImportKey = payload.session_id;
          pushImportLog('info', 'backend:session-created',
            `会话创建: ${(payload.session_id || sessionId).slice(0, 16)} | ${payload.name || '?'} | ${payload.total_chunks ?? 0} 块`,
            { sessionId: payload.session_id || sessionId, detail: { name: payload.name, total_chunks: payload.total_chunks } },
          );
          break;
        }
        case 'ChunkStart': {
          const s = getOrCreateImport(sessionId);
          if (!s.structuringStartAt) s.structuringStartAt = Date.now();
          pushImportLog('info', 'backend:chunk-start',
            `块 ${(payload.chunk_index ?? 0) + 1}/${payload.total_chunks} 开始解析`,
            { sessionId, detail: { chunk_index: payload.chunk_index, total_chunks: payload.total_chunks } },
          );
          break;
        }
        case 'ChunkCompleted': {
          const s = getOrCreateImport(sessionId);
          s.chunksCompleted = (payload.chunk_index ?? 0) + 1;
          s.totalChunks = payload.total_chunks ?? s.totalChunks;
          s.totalParsed = payload.total_parsed ?? s.totalParsed;
          pushImportLog('info', 'backend:chunk-completed',
            `块 ${s.chunksCompleted}/${s.totalChunks} 完成 | 本块 ${payload.questions_in_chunk ?? 0} 题, 累计 ${s.totalParsed} 题`,
            { sessionId, detail: { chunk_index: payload.chunk_index, total_chunks: payload.total_chunks, questions_in_chunk: payload.questions_in_chunk, total_parsed: payload.total_parsed } },
          );
          break;
        }
        case 'QuestionParsed': {
          const s = getOrCreateImport(sessionId);
          s.totalParsed = payload.total_parsed ?? s.totalParsed;
          const qContent = payload.question?.content;
          const preview = typeof qContent === 'string' ? qContent.slice(0, 60) : '';
          pushImportLog('debug', 'backend:question-parsed',
            `题目 #${payload.total_parsed}: ${preview}${preview.length >= 60 ? '...' : ''}`,
            { sessionId, detail: { question_index: payload.question_index, total_parsed: payload.total_parsed, question_type: payload.question?.question_type } },
          );
          break;
        }
        case 'Completed': {
          const s = getOrCreateImport(payload.session_id || sessionId);
          s.completedAt = Date.now();
          const totalMs = s.startAt ? s.completedAt - s.startAt : undefined;
          pushImportLog('success', 'backend:completed',
            `★ 导入完成: ${payload.name || '?'} | ${payload.total_questions ?? 0} 道题目 | 总耗时 ${totalMs ?? '?'}ms`,
            { sessionId: payload.session_id || sessionId, durationMs: totalMs, detail: { name: payload.name, total_questions: payload.total_questions } },
          );
          emitImportSummary(s);
          break;
        }
        case 'Failed': {
          const s = getOrCreateImport(payload.session_id || sessionId);
          s.failedAt = Date.now();
          pushImportLog('error', 'backend:failed',
            `导入失败: ${payload.error} | 已解析 ${payload.total_parsed ?? 0} 题`,
            { sessionId: payload.session_id || sessionId, detail: { error: payload.error, total_parsed: payload.total_parsed } },
          );
          emitImportSummary(s);
          break;
        }
        default:
          pushImportLog('debug', 'system', `未知事件类型: ${type}`, { sessionId, detail: payload });
      }
    });
    pushImportLog('info', 'system', 'Tauri question_import_progress 监听器已注册');
  } catch (err) {
    pushImportLog('error', 'system', `Tauri 监听器注册失败: ${err}`);
  }
}

// 模块加载时即注册
if (typeof window !== 'undefined') {
  attachTauriListener();
}
