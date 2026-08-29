/**
 * 附件删除三路径 source 矩阵（0824 Wave2-C R7 · 测试员-附件三路径）
 *
 * 与既有测试的分工：
 * - src/features/chat/core/store/__tests__/sessionActions.attachmentLifecycle.test.ts
 *   验证 store 两个 action 的【行为】语义（mock cancel/revoke/pdfStore 后调 action）；
 * - src/features/chat/components/input-bar/__tests__/AttachmentPreviewChips.removeCancels.source.test.ts
 *   只切 chip 一条路径的 source 契约；
 * - 本文件是【三入口 × 各站点】的横向 source 矩阵：把「面板行删 / chip X 删 / 全部清除」
 *   三条 UI 路径的每一站（入口委托 → InputBarUI 接线 → useInputBarV2 终点 → store action）
 *   放进同一张表逐格断言，锁定两条不变量：
 *     ① 三路径全部收敛进 store（sessionActions.removeAttachment / clearAttachments），
 *        途中每一站都是裸委托，没有旁路清理；
 *     ② UI 层零 cancel：cancelPdfProcessing 在整个 chat feature 生产源里
 *        只允许 sessionActions.ts 一个所有者（唯一所有者扫描）。
 *
 * 预期状态：卡 1（remove/clear 语义收敛进 store）在当前源码上已落地
 * （sessionActions.ts 的 cancelAttachmentProcessing helper + AttachmentPanelBody
 * 去 cancel/revoke 化），因此本矩阵应全绿 —— 定位是防回潮，而非 TDD 红灯。
 * 若未来有人把 cancel / revoke / pdfStore 清理加回任一 UI 入口，或把入口
 * 委托改道（不再进 store），对应格子直接红。
 *
 * 刻意不锁的东西：
 * - InputBarUI 对 vfsPdfProcessingApi 的 import 本身 —— 它合法持有
 *   getBatchPdfProcessingStatus / retryPdfProcessing（进度轮询 + 重试），
 *   只有 cancelPdfProcessing 这个 token 被禁；
 * - InputBarUI 的宿主级兜底 revoke（卸载清理 + 文件读取失败清理）——
 *   属于「创建失败/宿主销毁」所有权，不是删除路径；矩阵只正向锁
 *   卸载兜底仍在（防止收敛时被顺手删掉）。
 *
 * 父代理本轮不跑测试，本文件只提交源码，未执行。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// 源文件登记
// ============================================================================

const CHAT_FEATURE_DIR = resolve(process.cwd(), 'src/features/chat');

const FILES = {
  panel: 'src/features/chat/components/input-bar/AttachmentPanelBody.tsx',
  chips: 'src/features/chat/components/input-bar/AttachmentPreviewChips.tsx',
  inputBar: 'src/features/chat/components/input-bar/InputBarUI.tsx',
  hook: 'src/features/chat/components/input-bar/useInputBarV2.ts',
  messagePreview: 'src/features/chat/components/AttachmentPreview.tsx',
  store: 'src/features/chat/core/store/sessionActions.ts',
} as const;

type FileKey = keyof typeof FILES;

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const source: Record<FileKey, string> = Object.fromEntries(
  (Object.entries(FILES) as Array<[FileKey, string]>).map(([key, rel]) => [key, read(rel)])
) as Record<FileKey, string>;

/** 按锚点切出一个 store action 的实现体（与 removeCancels.source 测试同款锚点） */
const sliceBetween = (text: string, startAnchor: string, endAnchor: string) => {
  const start = text.indexOf(startAnchor);
  const end = text.indexOf(endAnchor, start);
  return { start, end, slice: start > -1 && end > start ? text.slice(start, end) : '' };
};

const storeSlices = {
  removeAttachment: sliceBetween(
    source.store,
    'removeAttachment: (attachmentId: string): void =>',
    'clearAttachments:'
  ),
  clearAttachments: sliceBetween(
    source.store,
    'clearAttachments: (): void =>',
    'setPanelState:'
  ),
} as const;

// ============================================================================
// 矩阵定义：三条删除路径 × 四个站点
// ============================================================================

interface RemovePathRow {
  /** 路径名（用例命名 + 失败信息） */
  label: string;
  /** 入口文件 */
  entry: FileKey;
  /** 站点 1 · 入口委托：用户手势翻译成回调的那一行（裸委托，无本地清理包装） */
  entryDelegations: string[];
  /** 站点 2 · InputBarUI 接线：入口回调接到 store 回调 prop（JSX 裸传，无 wrapper） */
  hostWiring: string;
  /** 站点 3 · useInputBarV2 终点：直达 store action */
  hookTerminal: string;
  /** 站点 4 · store 端 action（切片内必须含 cancel 调用） */
  storeAction: keyof typeof storeSlices;
}

const REMOVE_PATH_MATRIX: RemovePathRow[] = [
  {
    label: '面板行删（AttachmentPanelBody 行内「移除」）',
    entry: 'panel',
    entryDelegations: ['onClick={() => onRemoveAttachment(attachment.id)}'],
    hostWiring: 'onRemoveAttachment={onRemoveAttachment}',
    hookTerminal: 'store.getState().removeAttachment(attachmentId)',
    storeAction: 'removeAttachment',
  },
  {
    label: 'chip X 删（AttachmentPreviewChips）',
    entry: 'chips',
    entryDelegations: ['onRemove(attachment.id)'],
    hostWiring: 'onRemove={onRemoveAttachment}',
    hookTerminal: 'store.getState().removeAttachment(attachmentId)',
    storeAction: 'removeAttachment',
  },
  {
    label: '清空（AttachmentPanelBody「全部清除」· 移动端菜单行 + 桌面按钮）',
    entry: 'panel',
    // 同一回调两个渲染分支各挂一次：移动端 AppMenuItem 与桌面 DsButton
    entryDelegations: ['onClick={onClearAttachments}', 'onClick={onClearAttachments}'],
    hostWiring: 'onClearAttachments={onClearAttachments}',
    hookTerminal: 'store.getState().clearAttachments()',
    storeAction: 'clearAttachments',
  },
];

/**
 * UI 零 cancel 矩阵：文件 × 禁用 token。
 * inputBar 只禁 cancelPdfProcessing（轮询/重试 import 合法）；
 * 其余 UI 文件连 vfsPdfProcessingApi 模块名都不许出现。
 */
const UI_FORBIDDEN_TOKENS: Array<{ file: FileKey; forbidden: string[] }> = [
  {
    file: 'panel',
    forbidden: [
      'cancelPdfProcessing',
      'vfsPdfProcessingApi',
      'revokeObjectURL',
      'usePdfProcessingStore.getState()',
    ],
  },
  {
    file: 'chips',
    forbidden: [
      'cancelPdfProcessing',
      'vfsPdfProcessingApi',
      'revokeObjectURL',
      'usePdfProcessingStore.getState()',
    ],
  },
  {
    file: 'hook',
    forbidden: ['cancelPdfProcessing', 'vfsPdfProcessingApi', 'revokeObjectURL'],
  },
  {
    file: 'messagePreview',
    forbidden: ['cancelPdfProcessing', 'vfsPdfProcessingApi', 'revokeObjectURL'],
  },
  {
    file: 'inputBar',
    forbidden: ['cancelPdfProcessing'],
  },
];

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** 递归列出 chat feature 生产源（排除 __tests__），返回相对 chat 目录的 posix 路径 */
const listChatProductionSources = (): string[] => {
  const files: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(join(CHAT_FEATURE_DIR, relativeDir), {
      withFileTypes: true,
    })) {
      if (entry.name === '__tests__') continue;
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(relPath);
      }
    }
  };
  walk('');
  return files;
};

// ============================================================================
// 防空断言：文件 / 锚点漂移时直接红，不让矩阵空转通过
// ============================================================================

describe('attachment remove-path matrix: anchors', () => {
  it('reads every registered source file non-empty', () => {
    for (const [key, rel] of Object.entries(FILES)) {
      expect(source[key as FileKey].length, `${rel} 应存在且非空`).toBeGreaterThan(0);
    }
  });

  it('keeps the store action slice anchors this matrix cuts on', () => {
    expect(storeSlices.removeAttachment.start).toBeGreaterThan(-1);
    expect(storeSlices.removeAttachment.end).toBeGreaterThan(storeSlices.removeAttachment.start);
    expect(storeSlices.clearAttachments.start).toBeGreaterThan(-1);
    expect(storeSlices.clearAttachments.end).toBeGreaterThan(storeSlices.clearAttachments.start);
  });
});

// ============================================================================
// 矩阵 ① 三路径全部进 store：入口 → 接线 → hook 终点 → store action
// ============================================================================

describe.each(REMOVE_PATH_MATRIX)('remove path: $label', (row) => {
  it('入口层裸委托（每个渲染分支各一次，无本地清理包装）', () => {
    const entrySource = source[row.entry];
    const uniqueDelegations = [...new Set(row.entryDelegations)];
    for (const delegation of uniqueDelegations) {
      const expected = row.entryDelegations.filter((d) => d === delegation).length;
      expect(
        countOccurrences(entrySource, delegation),
        `${FILES[row.entry]} 应恰好 ${expected} 次出现「${delegation}」（少=入口丢失，多=分支复制）`
      ).toBe(expected);
    }
  });

  it('InputBarUI 把入口接到 store 回调 prop（JSX 裸传，无 wrapper 改道）', () => {
    expect(
      source.inputBar,
      `InputBarUI.tsx 应包含接线「${row.hostWiring}」`
    ).toContain(row.hostWiring);
  });

  it('useInputBarV2 终点直达 store action', () => {
    expect(
      source.hook,
      `useInputBarV2.ts 应包含终点「${row.hookTerminal}」`
    ).toContain(row.hookTerminal);
  });

  it('store action 切片内持有 cancel 调用（sourceId 门控的 fire-and-forget）', () => {
    // 允许直接调 cancelPdfProcessing 或经 cancelAttachmentProcessing helper —
    // 锁语义（action 里发生 cancel），不锁 helper 名。
    expect(storeSlices[row.storeAction].slice).toMatch(
      /cancelAttachmentProcessing\(|cancelPdfProcessing\(/
    );
  });
});

// ============================================================================
// 矩阵 ② UI 零 cancel / 零旁路清理
// ============================================================================

describe('UI layer stays cancel-free (all cleanup owned by sessionActions)', () => {
  it.each(UI_FORBIDDEN_TOKENS)('$file 不含禁用 token', ({ file, forbidden }) => {
    for (const token of forbidden) {
      expect(
        source[file],
        `${FILES[file]} 不得出现「${token}」（清理所有权归 sessionActions）`
      ).not.toContain(token);
    }
  });

  it('cancelPdfProcessing 在 chat feature 生产源里唯一所有者是 sessionActions.ts', () => {
    const productionSources = listChatProductionSources();
    // 防空：扫描失效时红，而不是唯一性断言空转通过
    expect(productionSources.length).toBeGreaterThan(0);
    expect(productionSources).toContain('core/store/sessionActions.ts');

    const owners = productionSources.filter((rel) =>
      readFileSync(join(CHAT_FEATURE_DIR, rel), 'utf-8').includes('cancelPdfProcessing')
    );
    expect(
      owners,
      'cancelPdfProcessing 只允许 sessionActions.ts 一个生产调用点'
    ).toEqual(['core/store/sessionActions.ts']);
  });

  it('store 端 cancel 是 fire-and-forget（void + .catch 吞错，不阻断同步删除）', () => {
    expect(source.store).toMatch(/void cancelPdfProcessing\([^)]*\)\.catch\(/);
  });

  it('store 两个 action 切片各自持有前端清理（revoke + pdfStore 清 key），UI 无需补偿', () => {
    for (const action of ['removeAttachment', 'clearAttachments'] as const) {
      expect(storeSlices[action].slice).toContain('URL.revokeObjectURL');
      expect(storeSlices[action].slice).toContain('usePdfProcessingStore.getState().remove(');
    }
  });

  it('InputBarUI 宿主卸载兜底 revoke 保留（收敛不许顺手删宿主销毁清理）', () => {
    expect(
      source.inputBar.match(/attachmentsRef\.current\.forEach[\s\S]{0,200}?revokeObjectURL/)
    ).not.toBeNull();
  });
});
