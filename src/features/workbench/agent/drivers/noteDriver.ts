/**
 * ACR note Driver — R1-12 / R2-03
 *
 * 流式 note_insert（词级分批 + AI 光标 decoration）+ dirty/hot 破坏类走 canvas:ai-edit-request 建议模式。
 * registerNoteEditor / unregisterNoteEditor / getNoteEditor 供 NoteContentView（R1-13）挂载。
 *
 * R2-03：批次间经 agentHighlight caret 重映射（用户他处打字）；clean 破坏类直写 setMarkdown；
 * dirty+replace/set → suggestion → AIDiffPanel。
 * R3-01：probe hot（captureSelection）+ 追加类 waitWhileNoteHot 暂停等待。
 *
 * 设计：docs/dev/acr/DESIGN.md §5.2 / ROUND1 R1-12 / ROUND2 R2-03
 * 锚点对齐 R1-03：{ heading?, position: 'end'|'afterHeading' }
 */
import { editorViewCtx } from '@milkdown/kit/core';
import type { CrepeEditorApi } from '@/components/crepe/types';
import {
  agentHighlightKey,
  type AgentHighlightMeta,
  type AgentHighlightState,
} from '@/components/crepe/plugins/agentHighlight';
import { isContentDirty } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { withUserPatch } from '../userPatch';
import type {
  AcrProbeState,
  AcrReceipt,
  AcrRunContext,
  AcrTarget,
  AgentOp,
  CollabDriver,
  PacingProfile,
  StageManagerApi,
} from '../types';

const editors = new Map<string, CrepeEditorApi>();

/** 活跃 run 的中止旗标 */
const abortFlags = new Map<string, boolean>();

/** fadeRun 后 clearAll 定时器（按 runId） */
const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>();

const FADE_CLEAR_MS = 3000;

export function registerNoteEditor(resourceId: string, api: CrepeEditorApi): void {
  editors.set(resourceId, api);
}

export function unregisterNoteEditor(resourceId: string, api?: CrepeEditorApi): void {
  if (!api || editors.get(resourceId) === api) {
    editors.delete(resourceId);
  }
}

export function getNoteEditor(resourceId: string): CrepeEditorApi | undefined {
  return editors.get(resourceId);
}

/** R1-03 / DESIGN §5.2 锚点形状 */
export interface NoteAnchor {
  heading?: string;
  /** 兼容 R1-03 可能带的 section 字段（等同 heading） */
  section?: string;
  position?: 'end' | 'afterHeading' | 'offset';
  offset?: number;
}

export interface NoteInsertPayload {
  content?: string;
  text?: string;
}

/**
 * 按词/标点切批：每批长度落在 [min, max]，优先在空白/标点处断开。
 * 导出供单测。
 */
export function splitTextIntoBatches(
  text: string,
  min: number,
  max: number,
): string[] {
  if (!text) return [];
  const batchMin = Math.max(1, Math.min(min, max));
  const batchMax = Math.max(batchMin, max);
  if (batchMin >= 9999 || text.length <= batchMax) {
    return [text];
  }

  const batches: string[] = [];
  let i = 0;
  while (i < text.length) {
    const remaining = text.length - i;
    if (remaining <= batchMax) {
      batches.push(text.slice(i));
      break;
    }
    const windowEnd = Math.min(i + batchMax, text.length);
    const window = text.slice(i, windowEnd);
    // 在 [batchMin, batchMax] 内找最佳断点（空白/标点优先，靠后）
    let breakAt = -1;
    for (let j = window.length - 1; j >= batchMin - 1; j--) {
      const ch = window[j]!;
      if (/\s/.test(ch) || /[，。！？；：、,.!?;:，]/.test(ch) || /[\u3000-\u303F]/.test(ch)) {
        breakAt = j + 1;
        break;
      }
    }
    if (breakAt < batchMin) {
      breakAt = batchMax;
    }
    batches.push(text.slice(i, i + breakAt));
    i += breakAt;
  }
  return batches;
}

/**
 * 解析锚点 → 文档插入位置。
 * end → getDocEndPos；afterHeading → resolveHeadingPos；失败返回 null。
 */
export function resolveNoteAnchorPos(
  api: Pick<CrepeEditorApi, 'getDocEndPos' | 'resolveHeadingPos'>,
  anchor: NoteAnchor | null | undefined,
): number | null {
  const position = anchor?.position ?? 'end';
  const heading = (anchor?.heading ?? anchor?.section ?? '').trim();

  if (position === 'afterHeading') {
    if (!heading) return null;
    return api.resolveHeadingPos(heading);
  }

  if (position === 'offset' && typeof anchor?.offset === 'number') {
    const end = api.getDocEndPos();
    return Math.max(0, Math.min(anchor.offset, end));
  }

  // end（默认）或带 heading 但 position=end：仍落文档末尾
  return api.getDocEndPos();
}

function parseAnchor(raw: unknown): NoteAnchor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: NoteAnchor = {};
  if (typeof o.heading === 'string') out.heading = o.heading;
  if (typeof o.section === 'string') out.section = o.section;
  if (o.position === 'end' || o.position === 'afterHeading' || o.position === 'offset') {
    out.position = o.position;
  }
  if (typeof o.offset === 'number') out.offset = o.offset;
  return out;
}

function extractInsertText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const o = payload as NoteInsertPayload;
  if (typeof o.content === 'string') return o.content;
  if (typeof o.text === 'string') return o.text;
  return '';
}

function emptyReceipt(
  partial: Partial<AcrReceipt> & Pick<AcrReceipt, 'status' | 'mode'>,
): AcrReceipt {
  return {
    applied: 0,
    totalOps: 0,
    entityIds: [],
    done: [],
    undone: [],
    ...partial,
  };
}

function clearFadeTimer(runId: string): void {
  const t = fadeTimers.get(runId);
  if (t != null) {
    clearTimeout(t);
    fadeTimers.delete(runId);
  }
}

function scheduleFadeClear(runId: string, api: CrepeEditorApi): void {
  clearFadeTimer(runId);
  const timer = setTimeout(() => {
    fadeTimers.delete(runId);
    try {
      api.agentSignal({ type: 'clearAll' });
    } catch {
      /* editor 可能已卸载 */
    }
  }, FADE_CLEAR_MS);
  fadeTimers.set(runId, timer);
}

function dispatchSuggestionEvent(detail: {
  requestId: string;
  noteId: string;
  operation: 'append' | 'replace' | 'set';
  content?: string;
  search?: string;
  replace?: string;
  isRegex?: boolean;
  section?: string;
}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail }));
}

/** 从 agentHighlight 插件读取当前 caret / 插入区间（供批次重映射与账本） */
export function readAgentHighlightState(
  api: Pick<CrepeEditorApi, 'getCrepe'>,
): AgentHighlightState | null {
  const crepe = api.getCrepe();
  if (!crepe) return null;
  try {
    let state: AgentHighlightState | null = null;
    crepe.editor.action((ctx) => {
      let view: { state: unknown } | null = null;
      try {
        view = ctx.get('editorView' as never);
      } catch {
        try {
          view = ctx.get(editorViewCtx as never);
        } catch {
          return;
        }
      }
      if (!view) return;
      state = agentHighlightKey.getState(view.state as never) ?? null;
    });
    return state;
  } catch {
    return null;
  }
}

/**
 * 计算破坏类编辑的提议正文（与 useAIEditState.computeProposedContent 对齐）。
 * 导出供单测。
 */
export function computeDestructiveMarkdown(
  original: string,
  op: Pick<AgentOp, 'kind' | 'payload' | 'anchor'>,
): { content: string; error?: string } {
  if (op.kind === 'note_set') {
    const payload = (op.payload ?? {}) as { content?: string };
    return { content: typeof payload.content === 'string' ? payload.content : '' };
  }

  if (op.kind === 'note_replace') {
    const payload = (op.payload ?? {}) as {
      search?: string;
      replace?: string;
      isRegex?: boolean;
    };
    const searchPattern = payload.search ?? '';
    const replaceWith = payload.replace ?? '';
    if (!searchPattern) {
      return { content: original, error: '搜索模式为空' };
    }
    if (payload.isRegex) {
      try {
        const regex = new RegExp(searchPattern, 'g');
        return { content: original.replace(regex, replaceWith) };
      } catch (err) {
        return {
          content: original,
          error: `无效的正则表达式: ${err instanceof Error ? err.message : '语法错误'}`,
        };
      }
    }
    return { content: original.split(searchPattern).join(replaceWith) };
  }

  return { content: original, error: `不支持的破坏类 op：${op.kind}` };
}

/** 编辑器有选区/光标快照 → 视为用户正在目标文档内编辑（hot） */
export function isNoteEditorHot(api: Pick<CrepeEditorApi, 'captureSelection'>): boolean {
  try {
    const sel = api.captureSelection?.();
    return sel != null && typeof sel.from === 'number';
  } catch {
    return false;
  }
}

function shouldUseSuggestionMode(resourceId: string, api?: CrepeEditorApi): boolean {
  // DESIGN §1.1 / §4.1：dirty（或 hot）破坏类走建议模式；clean 直写演出
  if (isContentDirty('note', resourceId)) return true;
  if (api && isNoteEditorHot(api)) return true;
  return false;
}

/** S-SUG-04：hot 等待时的 pause/resume 钩子（registerNoteDriver 绑定，避免循环依赖） */
export type NoteHotPauseHooks = {
  pauseRun: (runId: string) => void;
  resumeRun: (runId: string) => void;
};

let noteHotPauseHooks: NoteHotPauseHooks | null = null;

/** 测试 / registerNoteDriver 注入；传 null 清除 */
export function bindNoteHotPauseHooks(hooks: NoteHotPauseHooks | null): void {
  noteHotPauseHooks = hooks;
}

/**
 * S-SUG-04：追加类 op 遇 hot → 显式暂停，轮询至光标离开后 resume。
 */
async function waitWhileNoteHot(
  run: AcrRunContext,
  api: CrepeEditorApi,
  resourceId: string,
  step: number,
  totalOps: number,
): Promise<'resume' | 'abort'> {
  if (!isNoteEditorHot(api)) return 'resume';

  let hooks = noteHotPauseHooks;
  if (!hooks) {
    const { stageManager } = await import('../stageManager');
    const sm = stageManager as typeof stageManager & {
      resumeRun?: (runId: string) => void;
    };
    hooks = {
      pauseRun: (id) => sm.pauseRun(id),
      resumeRun: (id) => {
        sm.resumeRun?.(id);
      },
    };
  }

  hooks.pauseRun(run.runId);
  run.reportProgress(
    step,
    totalOps,
    '已暂停：光标在编辑区，移开后继续',
    resourceId,
  );

  for (;;) {
    if (abortFlags.get(run.runId)) return 'abort';

    const decision = await Promise.race([
      run.checkPaused(),
      new Promise<'poll'>((resolve) => setTimeout(() => resolve('poll'), 200)),
    ]);

    if (decision === 'abort') return 'abort';

    if (!isNoteEditorHot(api)) {
      hooks.resumeRun(run.runId);
      return 'resume';
    }

    // 仍 hot：保持 pausedByUser；若误续放则重新 pause，并强制等一轮防忙等
    if (decision === 'resume') {
      hooks.pauseRun(run.runId);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * 批次间重映射插入点：用户在他处打字时，agentHighlight 已 map caret；
 * 优先读插件 caret，否则回退到调用方传入的 pos。
 * 导出供并发交错单测。
 */
export function remapInsertPos(
  api: Pick<CrepeEditorApi, 'getCrepe' | 'getDocEndPos'>,
  fallbackPos: number,
): number {
  const hl = readAgentHighlightState(api);
  const end = api.getDocEndPos();
  if (hl?.caretPos != null) {
    return Math.max(0, Math.min(hl.caretPos, end));
  }
  return Math.max(0, Math.min(fallbackPos, end));
}

function deleteRangeViaEditor(api: CrepeEditorApi, from: number, to: number): void {
  const crepe = api.getCrepe();
  if (!crepe || from >= to) return;
  try {
    crepe.editor.action((ctx) => {
      let view: {
        state: {
          tr: { delete: (a: number, b: number) => { setMeta: (k: string, v: unknown) => unknown } };
          doc: { content: { size: number } };
        };
        dispatch: (tr: unknown) => void;
      } | null = null;
      try {
        view = ctx.get('editorView' as never);
      } catch {
        try {
          view = ctx.get(editorViewCtx as never);
        } catch {
          return;
        }
      }
      if (!view) return;
      const max = view.state.doc.content.size;
      const a = Math.max(0, Math.min(from, max));
      const b = Math.max(a, Math.min(to, max));
      if (a >= b) return;
      const tr = view.state.tr.delete(a, b);
      tr.setMeta('addToHistory', false);
      view.dispatch(tr);
    });
  } catch (err) {
    console.warn('[ACR noteDriver] revert delete failed:', err);
  }
}

async function applyNoteInsert(
  run: AcrRunContext,
  op: AgentOp,
  api: CrepeEditorApi,
  stepIndex: number,
  totalOps: number,
): Promise<{ ok: boolean; reason?: string; startPos?: number; endPos?: number }> {
  const text = extractInsertText(op.payload);
  if (!text) {
    return { ok: false, reason: '插入内容为空' };
  }

  const anchor = parseAnchor(op.anchor);
  const startPos = resolveNoteAnchorPos(api, anchor);
  if (startPos == null) {
    return {
      ok: false,
      reason: `无法解析锚点${anchor?.heading || anchor?.section ? `「${anchor.heading ?? anchor.section}」` : ''}`,
    };
  }

  const profile: PacingProfile = run.pacing.profile;
  const batches = splitTextIntoBatches(text, profile.typeBatchMin, profile.typeBatchMax);

  api.agentSignal({ type: 'caret', pos: startPos } satisfies AgentHighlightMeta);

  let pos = startPos;
  /** 账本用：首批实际插入起点（可能因用户编辑被 remap） */
  let ledgerFrom: number | null = null;
  let inserted = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    if (abortFlags.get(run.runId)) {
      return {
        ok: false,
        reason: 'aborted',
        startPos: ledgerFrom ?? startPos,
        endPos: pos,
      };
    }

    const pause = await run.checkPaused();
    if (pause === 'abort') {
      abortFlags.set(run.runId, true);
      return {
        ok: false,
        reason: 'aborted',
        startPos: ledgerFrom ?? startPos,
        endPos: pos,
      };
    }

    // 打字机节拍：用 typeIntervalMs 相对 opIntervalMs 的权重
    const cost =
      profile.opIntervalMs > 0
        ? profile.typeIntervalMs / profile.opIntervalMs
        : 1;
    await run.pacing.tick(profile.instant ? 0 : Math.max(0.05, cost));

    if (abortFlags.get(run.runId)) {
      return {
        ok: false,
        reason: 'aborted',
        startPos: ledgerFrom ?? startPos,
        endPos: pos,
      };
    }

    // R2-03：用户他处打字后，经 decoration mapping 重取插入点
    pos = remapInsertPos(api, pos);

    const chunk = batches[bi]!;
    const before = pos;
    pos = api.agentInsert(chunk, pos);
    if (ledgerFrom == null) ledgerFrom = before;
    inserted += chunk.length;

    run.reportProgress(
      stepIndex,
      totalOps,
      `${op.label}（${inserted}/${text.length}）`,
      run.target.resourceId,
    );
  }

  // 结束时再读一次高亮区间，保证账本覆盖整段 agent 插入（含用户交错后的 map）
  const hl = readAgentHighlightState(api);
  let endPos = pos;
  let fromPos = ledgerFrom ?? startPos;
  if (hl && hl.ranges.length > 0) {
    const nonFading = hl.ranges.filter((r) => !r.fading);
    const useRanges = nonFading.length > 0 ? nonFading : hl.ranges;
    fromPos = Math.min(...useRanges.map((r) => r.from));
    endPos = Math.max(...useRanges.map((r) => r.to));
  }

  return { ok: true, startPos: fromPos, endPos };
}

function handleDestructiveSuggestion(
  run: AcrRunContext,
  op: AgentOp,
): AcrReceipt {
  const noteId = run.target.resourceId ?? '';
  const requestId = `${run.runId}:${op.kind}:${Date.now()}`;
  const anchor = parseAnchor(op.anchor);
  const section = anchor?.heading ?? anchor?.section;

  if (op.kind === 'note_replace') {
    const payload = (op.payload ?? {}) as {
      search?: string;
      replace?: string;
      isRegex?: boolean;
    };
    dispatchSuggestionEvent({
      requestId,
      noteId,
      operation: 'replace',
      search: payload.search,
      replace: payload.replace,
      isRegex: payload.isRegex,
      section,
    });
  } else {
    // note_set
    const payload = (op.payload ?? {}) as { content?: string };
    dispatchSuggestionEvent({
      requestId,
      noteId,
      operation: 'set',
      content: payload.content,
      section,
    });
  }

  return emptyReceipt({
    status: 'completed',
    mode: 'suggestion',
    applied: 0,
    totalOps: 1,
    entityIds: noteId ? [noteId] : [],
    done: [`已提交建议：${op.label}`],
    undone: [],
    suggestionPending: true,
    message: '已提交编辑建议，等待用户在 diff 面板确认（accept/reject）',
  });
}

/**
 * clean 窗破坏类：直接 setMarkdown（触发 onChange→autosave），记账本为整篇还原。
 */
function applyDestructiveDirect(
  run: AcrRunContext,
  op: AgentOp,
  api: CrepeEditorApi,
): { ok: boolean; reason?: string; previousMarkdown?: string } {
  let previous = '';
  try {
    previous = api.getMarkdown();
  } catch {
    return { ok: false, reason: '无法读取当前笔记正文' };
  }
  const computed = computeDestructiveMarkdown(previous, op);
  if (computed.error) {
    return { ok: false, reason: computed.error };
  }
  try {
    api.setMarkdown(computed.content);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'setMarkdown 失败',
    };
  }
  const snapshot = previous;
  run.ledger.record(
    run.runId,
    () => {
      try {
        api.setMarkdown(snapshot);
      } catch (e) {
        console.warn('[ACR noteDriver] revert setMarkdown failed:', e);
      }
    },
    `撤销：${op.label}`,
  );
  return { ok: true, previousMarkdown: previous };
}

export const noteDriver: CollabDriver = {
  typeId: 'note',

  probe(target: AcrTarget): AcrProbeState {
    const id = target.resourceId;
    if (!id || !editors.has(id)) {
      // 无注册 editor → closed，让 Rust 回落后端
      return 'closed';
    }
    const api = editors.get(id);
    // S-SUG-04 / DESIGN §1.1：光标在编辑区 → hot（dirty 仍由 probe.ts / contentDirtyRegistry 优先）
    if (api && isNoteEditorHot(api)) {
      return 'hot';
    }
    return 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    abortFlags.set(run.runId, false);
    clearFadeTimer(run.runId);

    const resourceId = run.target.resourceId;
    if (!resourceId) {
      return emptyReceipt({
        status: 'failed',
        mode: 'frontend',
        totalOps: ops.length,
        undone: ops.map((o) => o.label),
        message: '缺少 resourceId，无法定位笔记编辑器',
      });
    }

    const api = getNoteEditor(resourceId);
    if (!api) {
      return emptyReceipt({
        status: 'failed',
        mode: 'frontend',
        totalOps: ops.length,
        undone: ops.map((o) => o.label),
        message:
          '笔记编辑器未挂载（窗口未打开或未就绪），请改走后端数据面或先 open_app note',
      });
    }

    const done: string[] = [];
    const undone: string[] = [];
    const entityIds: string[] = [resourceId];
    let applied = 0;
    let aborted = false;
    let lastInsertEnd: number | null = null;

    for (let i = 0; i < ops.length; i++) {
      if (abortFlags.get(run.runId)) {
        aborted = true;
        for (let j = i; j < ops.length; j++) {
          undone.push(ops[j]!.label);
        }
        break;
      }

      const op = ops[i]!;
      const pause = await run.checkPaused();
      if (pause === 'abort') {
        abortFlags.set(run.runId, true);
        aborted = true;
        for (let j = i; j < ops.length; j++) {
          undone.push(ops[j]!.label);
        }
        break;
      }

      run.reportProgress(i + 1, ops.length, op.label, resourceId);

      if (op.kind === 'note_replace' || op.kind === 'note_set') {
        // R2-03 / DESIGN §1.1：dirty → 建议模式；clean → 直写 setMarkdown
        if (shouldUseSuggestionMode(resourceId, api)) {
          const suggestion = handleDestructiveSuggestion(run, op);
          done.push(...suggestion.done);
          // suggestion 未改文档：applied 保持 0（与 mindmapDriver 一致）
          if (ops.length === 1) {
            abortFlags.delete(run.runId);
            return { ...suggestion, totalOps: ops.length, applied: 0, entityIds };
          }
          continue;
        }

        const direct = applyDestructiveDirect(run, op, api);
        if (direct.ok) {
          applied += 1;
          done.push(op.label);
        } else {
          undone.push(op.label);
          run.reportProgress(
            i + 1,
            ops.length,
            direct.reason ?? '破坏类写入失败',
            resourceId,
          );
        }
        continue;
      }

      if (op.kind !== 'note_insert' && op.kind !== 'note_append') {
        undone.push(op.label);
        run.reportProgress(i + 1, ops.length, `不支持的 op：${op.kind}`, resourceId);
        continue;
      }

      // S-SUG-04：hot 追加先暂停等待光标离开（非 suggestion）
      const hotWait = await waitWhileNoteHot(run, api, resourceId, i + 1, ops.length);
      if (hotWait === 'abort') {
        aborted = true;
        undone.push(op.label);
        for (let j = i + 1; j < ops.length; j++) {
          undone.push(ops[j]!.label);
        }
        break;
      }

      const result = await applyNoteInsert(run, op, api, i + 1, ops.length);
      if (result.ok && result.startPos != null && result.endPos != null) {
        const from = result.startPos;
        const to = result.endPos;
        lastInsertEnd = to;
        applied += 1;
        done.push(op.label);

        run.ledger.record(
          run.runId,
          () => {
            deleteRangeViaEditor(api, from, to);
          },
          `撤销：${op.label}`,
        );
      } else if (result.reason === 'aborted') {
        aborted = true;
        if (result.startPos != null && result.endPos != null && result.endPos > result.startPos) {
          const from = result.startPos;
          const to = result.endPos;
          applied += 1;
          done.push(`${op.label}（部分）`);
          run.ledger.record(
            run.runId,
            () => {
              deleteRangeViaEditor(api, from, to);
            },
            `撤销：${op.label}（部分）`,
          );
        }
        undone.push(op.label);
        for (let j = i + 1; j < ops.length; j++) {
          undone.push(ops[j]!.label);
        }
        break;
      } else {
        undone.push(op.label);
        run.reportProgress(
          i + 1,
          ops.length,
          result.reason ?? '插入失败',
          resourceId,
        );
      }
    }

    // 结束演出：fadeRun → 3s 后 clearAll
    try {
      if (lastInsertEnd != null || done.length > 0) {
        api.agentSignal({ type: 'fadeRun' });
        scheduleFadeClear(run.runId, api);
      } else {
        api.agentSignal({ type: 'clearAll' });
      }
    } catch {
      /* ignore */
    }

    abortFlags.delete(run.runId);

    const status = aborted
      ? 'partial'
      : undone.length > 0 && applied === 0
        ? 'failed'
        : undone.length > 0
          ? 'partial'
          : 'completed';

    const receipt = emptyReceipt({
      status,
      mode: 'frontend',
      applied,
      totalOps: ops.length,
      entityIds,
      done,
      undone,
      message: aborted
        ? '操作已中断，已返回部分结果'
        : status === 'completed'
          ? '已在前端实时应用（自动保存）'
          : undone.length > 0
            ? `部分步骤未完成：${undone.join('；')}`
            : undefined,
    });
    return withUserPatch(receipt, 'note');
  },

  abort(runId: string): AcrReceipt {
    abortFlags.set(runId, true);
    clearFadeTimer(runId);
    return withUserPatch(
      emptyReceipt({
        status: 'partial',
        mode: 'frontend',
        done: [],
        undone: ['已中止剩余步骤'],
        message: 'noteDriver 已中止',
      }),
      'note',
    );
  },
};

export function registerNoteDriver(stage: StageManagerApi): void {
  stage.registerDriver(noteDriver);
  const sm = stage as StageManagerApi & { resumeRun?: (runId: string) => void };
  bindNoteHotPauseHooks({
    pauseRun: (id) => sm.pauseRun(id),
    resumeRun: (id) => {
      sm.resumeRun?.(id);
    },
  });
}
