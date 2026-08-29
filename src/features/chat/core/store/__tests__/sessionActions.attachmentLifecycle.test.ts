/**
 * 附件删除三路径生命周期等价性契约测试（R4 卡「测试-附件生命周期」，配合卡 1）
 *
 * 【修复前应红 / 卡 1 后应绿】
 * 三条 UI 删除入口最终都收敛进 store 的 removeAttachment / clearAttachments：
 *   ① chip 删：AttachmentPreviewChips.tsx X 按钮 → onRemove(attachment.id)
 *      → InputBarUI onRemoveAttachment → useInputBarV2 → store.removeAttachment
 *   ② 面板删：AttachmentPanelBody.tsx 行内「移除」→ onRemoveAttachment → store.removeAttachment
 *   ③ 清空：AttachmentPanelBody.tsx「全部清除」→ onClearAttachments → store.clearAttachments
 *
 * 基线现状（账本 wave2-C-ledger.md P2「附件清理三所有者」）：
 * - store removeAttachment/clearAttachments（sessionActions.ts:204-306）缺 cancelPdfProcessing
 *   → chip 路径（①）删附件后后端处理任务变孤儿：本文件的 cancel 行为用例【修复前红】；
 * - AttachmentPanelBody（②③）在 UI 层自带 cancel + revokeObjectURL，再转调 store 重做一遍
 *   revoke → 双所有者/双 revoke：本文件的「UI 不含重复清理」source 契约【修复前红】。
 *
 * 卡 1 落地形态（cancelPdfProcessing fire-and-forget + 日志移入 store；
 * 删 AttachmentPanelBody UI 层重复清理；chips 自动继承；InputBarUI 宿主卸载
 * 兜底 revoke 保留）后，全部用例应绿 —— 此时三路径的清理语义由 store 单点保证，
 * 天然一致。
 *
 * 已是现状语义、修复前后都应绿的用例标注【防回归】，防止卡 1 收敛时误删既有清理
 * （ContextRef 同步移除 / pdfProcessingStore 按 sourceId 清理 / blob URL 释放）。
 *
 * mock 面：cancelPdfProcessing（@/api/vfsPdfProcessingApi）、URL.revokeObjectURL、
 * usePdfProcessingStore（@/features/pdf/stores/pdfProcessingStore）。
 *
 * 父代理本轮不跑测试，本文件只提交源码，未执行。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionActions } from '../sessionActions';
import type { AttachmentMeta, ChatStoreState } from '../types';
import { createInitialState } from '../types';

// ============================================================================
// Mocks
// ============================================================================

/** 后端取消处理任务（卡 1 后由 store 唯一持有调用点） */
const cancelPdfProcessingMock = vi.fn();

vi.mock('@/api/vfsPdfProcessingApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/vfsPdfProcessingApi')>();
  return {
    ...actual,
    cancelPdfProcessing: (...args: unknown[]) => cancelPdfProcessingMock(...args),
  };
});

/** pdfProcessingStore.remove（进度条目清理，按 sourceId 键） */
const pdfStoreRemoveMock = vi.fn();

vi.mock('@/features/pdf/stores/pdfProcessingStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/pdf/stores/pdfProcessingStore')>();
  return {
    ...actual,
    usePdfProcessingStore: {
      getState: () => ({
        remove: (...args: unknown[]) => pdfStoreRemoveMock(...args),
      }),
    },
  };
});

// sessionActions 模块加载时注册 plan_gate 事件处理器 → 与 authorityMode 测试同款隔离
vi.mock('../../registry/eventRegistry', () => {
  const handlers = new Map<string, unknown>();
  return {
    eventRegistry: {
      register: (type: string, handler: unknown) => {
        handlers.set(type, handler);
      },
      get: (type: string) => handlers.get(type),
      has: (type: string) => handlers.has(type),
    },
  };
});

/** jsdom 不实现 URL.revokeObjectURL：显式装 mock，测后还原 */
const revokeObjectURLMock = vi.fn();
const originalRevokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

beforeAll(() => {
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURLMock,
  });
});

afterAll(() => {
  if (originalRevokeDescriptor) {
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeDescriptor);
  } else {
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  }
});

// ============================================================================
// Harness & fixtures
// ============================================================================

function createHarness(attachments: AttachmentMeta[]) {
  const removeContextRefMock = vi.fn();
  let state = {
    ...createInitialState('sess_attach_life'),
    attachments,
    // removeAttachment/clearAttachments 会经 getState() 调 removeContextRef（contextActions），
    // 本 harness 只造 sessionActions，故直接把 mock 注入状态对象。
    removeContextRef: (resourceId: string) => removeContextRefMock(resourceId),
  } as unknown as ChatStoreState;

  const set = (
    partial: Partial<ChatStoreState> | ((s: ChatStoreState) => Partial<ChatStoreState>),
  ) => {
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
  };

  const actions = createSessionActions(set as never, () => state as never, () => {});

  return {
    actions,
    removeContextRefMock,
    getAttachments: () => state.attachments,
  };
}

function makeAttachment(overrides: Partial<AttachmentMeta> & { id: string }): AttachmentMeta {
  return {
    name: '附件.pdf',
    type: 'document',
    mimeType: 'application/pdf',
    size: 2048,
    status: 'processing',
    ...overrides,
  };
}

/** 处理中的 PDF：sourceId + resourceId + blob 预览，删除时全套清理都必须发生 */
const processingPdf = (): AttachmentMeta =>
  makeAttachment({
    id: 'att_pdf',
    name: '真题卷.pdf',
    sourceId: 'file_pdf_1',
    resourceId: 'res_pdf_1',
    previewUrl: 'blob:mock/pdf-1',
    status: 'processing',
  });

/** 已就绪图片：仍持有 sourceId（后端可能有残留任务/进度条目）+ blob 预览 */
const readyImage = (): AttachmentMeta =>
  makeAttachment({
    id: 'att_img',
    name: '板书.png',
    type: 'image',
    mimeType: 'image/png',
    sourceId: 'file_img_2',
    resourceId: 'res_img_2',
    previewUrl: 'blob:mock/img-2',
    status: 'ready',
  });

/** 无 sourceId / 无 resourceId / 非 blob 预览：删除时不许触碰 cancel / revoke / ContextRef */
const plainDoc = (): AttachmentMeta =>
  makeAttachment({
    id: 'att_txt',
    name: '讲义.txt',
    mimeType: 'text/plain',
    status: 'ready',
    previewUrl: 'data:text/plain;base64,aGk=',
  });

/** 只有 sourceId、还没拿到 resourceId 的中间态（上传/处理早期被删） */
const orphanSourcePdf = (): AttachmentMeta =>
  makeAttachment({
    id: 'att_orphan',
    name: '中间态.pdf',
    sourceId: 'file_orphan_3',
    status: 'processing',
  });

/** 冲刷 fire-and-forget 的 promise 微任务（含一拍宏任务，保证 .catch 已跑） */
async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  cancelPdfProcessingMock.mockReset();
  cancelPdfProcessingMock.mockResolvedValue(true);
  pdfStoreRemoveMock.mockReset();
  revokeObjectURLMock.mockReset();
});

// ============================================================================
// removeAttachment：chip 删（①）与面板删（②）收敛后的唯一删除语义
// ============================================================================

describe('sessionActions.removeAttachment 单附件删除语义（卡 1 修复前红/修复后绿）', () => {
  it('【修复前红】按 sourceId 取消后端处理任务，且恰好一次', async () => {
    const { actions } = createHarness([processingPdf()]);

    actions.removeAttachment('att_pdf');
    await flushAsync();

    // 基线红点：store 路径（= chip 删的全部路径）从不调用 cancelPdfProcessing，
    // 后端任务变孤儿。卡 1 移入后应恰好一次（面板路径也不得再叠加 UI 层第二次）。
    expect(cancelPdfProcessingMock).toHaveBeenCalledTimes(1);
    expect(cancelPdfProcessingMock).toHaveBeenCalledWith('file_pdf_1');
  });

  it('【修复前红】仅有 sourceId（无 resourceId）的中间态附件同样取消后端任务并清理 pdf store', async () => {
    // 面板路径今天就会 cancel 这种附件（AttachmentPanelBody 只看 att.sourceId）；
    // 收敛进 store 后该语义必须保住 —— cancel 键在 sourceId 上，不得受 resourceId 门控。
    const { actions, removeContextRefMock } = createHarness([orphanSourcePdf()]);

    actions.removeAttachment('att_orphan');
    await flushAsync();

    expect(cancelPdfProcessingMock).toHaveBeenCalledTimes(1);
    expect(cancelPdfProcessingMock).toHaveBeenCalledWith('file_orphan_3');
    // pdfProcessingStore 清理同样只受 sourceId 门控（R6 翻案：旧实现嵌在
    // resourceId 分支里，仅有 sourceId 的中间态附件删除后进度条目泄漏 → 此断言红）
    expect(pdfStoreRemoveMock).toHaveBeenCalledTimes(1);
    expect(pdfStoreRemoveMock).toHaveBeenCalledWith('file_orphan_3');
    // 无 resourceId → 没有 ContextRef 可移除
    expect(removeContextRefMock).not.toHaveBeenCalled();
  });

  it('【防回归】附件出列、ContextRef 同步移除、pdfProcessingStore 按 sourceId 清理', () => {
    const { actions, removeContextRefMock, getAttachments } = createHarness([processingPdf()]);

    actions.removeAttachment('att_pdf');

    expect(getAttachments()).toHaveLength(0);
    expect(removeContextRefMock).toHaveBeenCalledTimes(1);
    expect(removeContextRefMock).toHaveBeenCalledWith('res_pdf_1');
    // 进度条目键是 sourceId（file_id，与后端事件一致），不是 resourceId
    expect(pdfStoreRemoveMock).toHaveBeenCalledWith('file_pdf_1');
    expect(pdfStoreRemoveMock).not.toHaveBeenCalledWith('res_pdf_1');
  });

  it('【防回归→卡 1 加严】blob: previewUrl 恰好 revoke 一次（面板路径不得双 revoke）', () => {
    // 基线上 store 本身 revoke 一次（绿）；但面板删在 UI 层还会先 revoke 同一 URL，
    // 即面板整链是两次。收敛后 store 是唯一 revoke 点，本断言锁"恰好一次"。
    const { actions } = createHarness([processingPdf()]);

    actions.removeAttachment('att_pdf');

    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock/pdf-1');
  });

  it('无 sourceId 的附件不触发 cancel；非 blob previewUrl 不 revoke；仍正常出列', async () => {
    const { actions, getAttachments } = createHarness([plainDoc()]);

    actions.removeAttachment('att_txt');
    await flushAsync();

    expect(cancelPdfProcessingMock).not.toHaveBeenCalled();
    expect(pdfStoreRemoveMock).not.toHaveBeenCalled();
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
    expect(getAttachments()).toHaveLength(0);
  });

  it('【修复前红】cancel 是 fire-and-forget：后端拒绝不阻断删除、不向调用方抛出', async () => {
    cancelPdfProcessingMock.mockRejectedValue(new Error('backend gone'));
    const { actions, getAttachments } = createHarness([processingPdf()]);

    // removeAttachment 是同步 action：不得因 cancel 变 async、不得同步抛
    expect(() => actions.removeAttachment('att_pdf')).not.toThrow();
    expect(getAttachments()).toHaveLength(0);

    // 冲刷微任务：产品代码必须自带 .catch（fire-and-forget + 日志），
    // 否则此处会以 unhandled rejection 形式炸红整个用例文件。
    await flushAsync();
    expect(cancelPdfProcessingMock).toHaveBeenCalledWith('file_pdf_1');
  });

  it('只清理目标附件：同列表其他附件的任务/URL/ContextRef 一概不动', async () => {
    const { actions, removeContextRefMock, getAttachments } = createHarness([
      processingPdf(),
      readyImage(),
    ]);

    actions.removeAttachment('att_pdf');
    await flushAsync();

    expect(cancelPdfProcessingMock).not.toHaveBeenCalledWith('file_img_2');
    expect(pdfStoreRemoveMock).not.toHaveBeenCalledWith('file_img_2');
    expect(revokeObjectURLMock).not.toHaveBeenCalledWith('blob:mock/img-2');
    expect(removeContextRefMock).not.toHaveBeenCalledWith('res_img_2');
    expect(getAttachments()).toEqual([expect.objectContaining({ id: 'att_img' })]);
  });
});

// ============================================================================
// clearAttachments：清空路径（③）
// ============================================================================

describe('sessionActions.clearAttachments 清空路径语义（卡 1 修复前红/修复后绿）', () => {
  it('【修复前红】对每个含 sourceId 的附件各取消一次，无 sourceId 的不取消、不重复', async () => {
    const { actions } = createHarness([processingPdf(), readyImage(), plainDoc()]);

    actions.clearAttachments();
    await flushAsync();

    expect(cancelPdfProcessingMock).toHaveBeenCalledTimes(2);
    expect(cancelPdfProcessingMock).toHaveBeenCalledWith('file_pdf_1');
    expect(cancelPdfProcessingMock).toHaveBeenCalledWith('file_img_2');
    expect(cancelPdfProcessingMock).not.toHaveBeenCalledWith(undefined);
  });

  it('【防回归】列表清空、按 resourceId 移除 ContextRef、按 sourceId 清 pdf store', () => {
    const { actions, removeContextRefMock, getAttachments } = createHarness([
      processingPdf(),
      readyImage(),
      plainDoc(),
    ]);

    actions.clearAttachments();

    expect(getAttachments()).toHaveLength(0);
    expect(removeContextRefMock).toHaveBeenCalledTimes(2);
    expect(removeContextRefMock).toHaveBeenCalledWith('res_pdf_1');
    expect(removeContextRefMock).toHaveBeenCalledWith('res_img_2');
    expect(pdfStoreRemoveMock).toHaveBeenCalledTimes(2);
    expect(pdfStoreRemoveMock).toHaveBeenCalledWith('file_pdf_1');
    expect(pdfStoreRemoveMock).toHaveBeenCalledWith('file_img_2');
  });

  it('【防回归→卡 1 加严】每个 blob: URL 恰好 revoke 一次，非 blob 不 revoke', () => {
    const { actions } = createHarness([processingPdf(), readyImage(), plainDoc()]);

    actions.clearAttachments();

    expect(revokeObjectURLMock).toHaveBeenCalledTimes(2);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock/pdf-1');
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock/img-2');
    expect(revokeObjectURLMock).not.toHaveBeenCalledWith('data:text/plain;base64,aGk=');
  });

  it('空列表清空是无副作用 no-op', async () => {
    const { actions, removeContextRefMock, getAttachments } = createHarness([]);

    expect(() => actions.clearAttachments()).not.toThrow();
    await flushAsync();

    expect(getAttachments()).toHaveLength(0);
    expect(cancelPdfProcessingMock).not.toHaveBeenCalled();
    expect(pdfStoreRemoveMock).not.toHaveBeenCalled();
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
    expect(removeContextRefMock).not.toHaveBeenCalled();
  });

  it('【修复前红】清空的 cancel 同样 fire-and-forget：单个拒绝不阻断其余清理', async () => {
    cancelPdfProcessingMock.mockRejectedValue(new Error('backend gone'));
    const { actions, getAttachments } = createHarness([processingPdf(), readyImage()]);

    expect(() => actions.clearAttachments()).not.toThrow();
    expect(getAttachments()).toHaveLength(0);

    await flushAsync();
    expect(cancelPdfProcessingMock).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// 三 UI 入口收敛 source 契约：入口只委托，不自带第二份清理
// ============================================================================

describe('附件删除三入口收敛 source 契约（卡 1 修复前红/修复后绿）', () => {
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

  const panelBodySource = read('src/features/chat/components/input-bar/AttachmentPanelBody.tsx');
  const chipsSource = read('src/features/chat/components/input-bar/AttachmentPreviewChips.tsx');
  const inputBarSource = read('src/features/chat/components/input-bar/InputBarUI.tsx');
  const inputBarHookSource = read('src/features/chat/components/input-bar/useInputBarV2.ts');
  const sessionActionsSource = read('src/features/chat/core/store/sessionActions.ts');
  const messagePreviewSource = read('src/features/chat/components/AttachmentPreview.tsx');

  it('【修复前红】取消所有权收敛进 sessionActions（store 是 cancel 唯一调用点）', () => {
    expect(sessionActionsSource).toMatch(/cancelPdfProcessing/);
  });

  it('【修复前红】AttachmentPanelBody 不再自带 cancelPdfProcessing（删 UI 层重复取消）', () => {
    expect(panelBodySource).not.toMatch(/cancelPdfProcessing/);
  });

  it('【修复前红】AttachmentPanelBody 不再自行 revokeObjectURL（blob 释放归 store）', () => {
    expect(panelBodySource).not.toMatch(/revokeObjectURL/);
  });

  it('面板删/清空仍委托给 onRemoveAttachment / onClearAttachments（入口不改道）', () => {
    expect(panelBodySource).toMatch(/onRemoveAttachment/);
    expect(panelBodySource).toMatch(/onClearAttachments/);
  });

  it('chip X 保持裸委托 onRemove(attachment.id)，自身无 cancel / revoke', () => {
    expect(chipsSource).toMatch(/onRemove\(attachment\.id\)/);
    expect(chipsSource).not.toMatch(/cancelPdfProcessing/);
    expect(chipsSource).not.toMatch(/revokeObjectURL/);
  });

  it('InputBarUI 把 chip 与面板接到同一对回调（onRemoveAttachment / onClearAttachments）', () => {
    // chip 路径与面板路径共用同一 prop → 收敛点只有 store 一处
    expect(inputBarSource).toMatch(/onRemove=\{onRemoveAttachment\}/);
    expect(inputBarSource).toMatch(/onRemoveAttachment=\{onRemoveAttachment\}/);
    expect(inputBarSource).toMatch(/onClearAttachments=\{onClearAttachments\}/);
  });

  it('useInputBarV2 的删除/清空动作直达 store（中间层无旁路清理）', () => {
    expect(inputBarHookSource).toMatch(/store\.getState\(\)\.removeAttachment\(attachmentId\)/);
    expect(inputBarHookSource).toMatch(/store\.getState\(\)\.clearAttachments\(\)/);
    expect(inputBarHookSource).not.toMatch(/cancelPdfProcessing/);
  });

  it('消息态 AttachmentPreview 同样裸委托 store.removeAttachment（同族入口不例外）', () => {
    expect(messagePreviewSource).toMatch(/removeAttachment\(attachmentId\)/);
    expect(messagePreviewSource).not.toMatch(/cancelPdfProcessing/);
  });

  it('宿主卸载兜底 revoke 保留（InputBarUI 卸载清理不许被卡 1 顺手删掉）', () => {
    // 账本卡 1 明确"宿主卸载兜底 revoke 保留"：会话切换/卸载时释放全部 blob URL
    const unmountCleanup = inputBarSource.match(
      /attachmentsRef\.current\.forEach[\s\S]{0,200}?revokeObjectURL/,
    );
    expect(unmountCleanup).not.toBeNull();
  });
});
