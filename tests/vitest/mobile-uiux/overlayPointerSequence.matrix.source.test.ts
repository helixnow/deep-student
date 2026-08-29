/**
 * 浮层 pointer 矩阵（0824 Wave2-C R7 · 测试员-浮层 pointer 矩阵）
 *
 * ⚠️ 本轮未执行：按父代理指令禁止跑测试，本文件只提交源码，未运行、未验证。
 *    在当前 HEAD（owned-overlay 归属接线已落地，基线 0f5435a7）上预期全绿；
 *    若外点判定回退到「只认三个容器 ref」的基线行为，pointer 链各行应变红。
 *
 * 断言风格复用 InputBarUI.appMenuOutsideClick.pointer.test.tsx：全部走
 * pointerdown → 面板存活 → pointerup → click → 动作真正到达 的行为链，
 * 外加 source 契约锁双路径判定；不做「按钮存在」式弱断言。
 *
 * 覆盖矩阵：
 *
 *   路径维度（describe.each，owned overlay / closest 双路径）：
 *     A. owned-overlay 归属查询：包 OverlayCoordinatorProvider，InputBarUI 在
 *        面板打开窗口内向登记表登记 selector '[data-app-menu-id]'，谓词第四条
 *        isOwnedOverlayTarget 命中；
 *     B. closest 兜底：不包 Provider（fallback 语义 fail-empty，
 *        isOwnedOverlayTarget 恒 false），豁免只能来自谓词末条
 *        closest('[data-app-menu-id]') —— 该变体单独证明兜底路径自足。
 *
 *   场景维度：
 *     1. 附件面板「更多」菜单三动作：资源库 / 拍照 / 全部清除（it.each）；
 *     2. 加号菜单（移动端扁平列表）：添加文件 / 拍照 / 资源库（it.each）。
 *        注意产品语义：加号菜单打开时互斥收起组合面板
 *        （handleAttachmentMenuOpenChange → closeAllPanels），矩阵行先断言
 *        互斥关闭发生、清零信号，再在「受控面板 prop 尚未被父级回写收起」的
 *        边界窗口里验证 pointerdown 豁免 —— 这正是谓词注释里「登记窗口外 /
 *        面板刚关闭的同一事件」要兜住的 fail-open 形态；
 *     3. 真外点 pointerdown 仍关面板（反向对照，防监听未挂载假绿）；
 *     4. 合成 [data-app-menu-id] portal 节点（不依赖真实菜单渲染的判定兜底）；
 *     5. owned-overlay 路径隔离（仅 Provider 变体）：element 登记的
 *        「无 data-app-menu-id」浮层只有归属查询能豁免（closest 必不命中），
 *        附不登记对照证明豁免确实来自登记；另附登记窗口的纯函数边界。
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { InputBarUI } from '@/features/chat/components/input-bar/InputBarUI';
import {
  OverlayCoordinatorProvider,
  useOverlayCoordinator,
  type OverlayCoordinatorValue,
} from '@/components/shared/OverlayCoordinator';
import {
  createOwnedOverlayStore,
  isEventInsideOwnedOverlay,
  registerOwnedOverlayEntry,
} from '@/components/shared/overlayOwnership';
import { createDefaultPanelStates } from '@/features/chat/core/types/common';
import type { AttachmentMeta, PanelStates } from '@/features/chat/core/types/common';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

// 📱 移动端布局断点：走内联面板 + 加号菜单扁平列表 + 附件「更多」折叠菜单分支
vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: true,
    isFullscreenContent: false,
  }),
}));

// 设备能力 → canCapturePhoto=true：让「拍照」入口在两个菜单里都出现
// （R3 能力三分离后拍照入口不看 pointer 媒体查询，直接 mock 能力模块）
vi.mock('@/features/chat/components/input-bar/inputBarCapabilities', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/features/chat/components/input-bar/inputBarCapabilities')
  >();
  return { ...actual, canCapturePhoto: () => true };
});

/**
 * 与 InputBarUI.tsx 的 COMPOSER_OVERLAY_OWNER_ID 同步（模块私有常量，无法 import）。
 * 若产品侧改名，下方「常量与测试假设同步」source 契约会先红，提示同步此处。
 */
const COMPOSER_OWNER_ID = 'input-bar-composer';

function panelStatesWith(open: Partial<PanelStates>): PanelStates {
  return { ...createDefaultPanelStates(), ...open };
}

/** 无 sourceId / 无 blob previewUrl：清除路径不会触碰 cancelPdfProcessing / revokeObjectURL */
const plainAttachment: AttachmentMeta = {
  id: 'att_doc',
  name: '讲义.txt',
  type: 'document',
  mimeType: 'text/plain',
  size: 512,
  status: 'ready',
};

interface RenderResult {
  onSetPanelState: ReturnType<typeof vi.fn>;
  onClearAttachments: ReturnType<typeof vi.fn>;
  /** 仅 withProvider=true 时非 null：与 InputBarUI 同一 Provider 的协调器实例 */
  getCoordinator: () => OverlayCoordinatorValue | null;
}

function renderInputBar(
  withProvider: boolean,
  overrides: Partial<React.ComponentProps<typeof InputBarUI>> = {},
): RenderResult {
  const onSetPanelState = vi.fn();
  const onClearAttachments = vi.fn();
  const props: React.ComponentProps<typeof InputBarUI> = {
    inputValue: '',
    canSend: false,
    canAbort: false,
    isStreaming: false,
    attachments: [],
    panelStates: panelStatesWith({ attachment: true }),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onAddAttachment: vi.fn(),
    onUpdateAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments,
    onSetPanelState,
    placeholder: '输入消息',
    ...overrides,
  };

  let coordinator: OverlayCoordinatorValue | null = null;
  // 探针与 InputBarUI 同处一个 Provider：测试可用同一登记表补登 element 归属
  const CoordinatorProbe: React.FC = () => {
    coordinator = useOverlayCoordinator();
    return null;
  };

  const inputBar = React.createElement(InputBarUI, props);
  render(
    withProvider
      ? React.createElement(
          OverlayCoordinatorProvider,
          null,
          React.createElement(CoordinatorProbe),
          inputBar,
        )
      : inputBar,
  );

  return { onSetPanelState, onClearAttachments, getCoordinator: () => coordinator };
}

/** 手工构造带 type 的指针事件：不依赖 jsdom 是否实现 PointerEvent 构造器 */
function firePointer(el: Element, type: 'pointerdown' | 'pointerup') {
  return fireEvent(
    el,
    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }),
  );
}

/**
 * 核心断言：pointerdown 落在浮层上之后，面板不能被 closeAllPanels 关闭。
 * panelStates 是受控 prop，「被关闭」的可观测信号就是 onSetPanelState('attachment', false)。
 */
function expectPanelSurvivedPointerDown(
  root: HTMLElement,
  onSetPanelState: ReturnType<typeof vi.fn>,
) {
  expect(onSetPanelState).not.toHaveBeenCalledWith('attachment', false);
  expect(root.querySelector('[data-composer-panel-inline="attachment"]')).not.toBeNull();
}

/**
 * 打开附件面板头部的「更多」AppMenu，并校验内容层确实是 body 上的
 * [data-app-menu-id] portal（pointerdown 目标位于三个豁免容器之外，
 * 正是双路径豁免要兜住的形态）。
 */
function openAttachmentMoreMenu() {
  const root = screen.getByTestId('input-bar-v2-root');
  expect(root.querySelector('[data-composer-panel-inline="attachment"]')).not.toBeNull();

  fireEvent.click(screen.getByTestId('attachment-panel-more'));

  const menu = screen.getByRole('menu');
  expect(menu).toHaveAttribute('data-app-menu-id');
  expect(menu.parentElement).toBe(document.body);
  expect(root.contains(menu)).toBe(false);

  return { root, menu, items: within(menu).getAllByRole('menuitem') };
}

/** 打开加号菜单（移动端扁平列表），校验内容层同为 body 上的 [data-app-menu-id] portal */
async function openPlusMenu() {
  const root = screen.getByTestId('input-bar-v2-root');
  fireEvent.click(screen.getByTestId('btn-toggle-attachments'));

  const menu = await screen.findByTestId('composer-plus-menu');
  expect(menu).toHaveAttribute('data-app-menu-id');
  expect(menu.parentElement).toBe(document.body);
  expect(root.contains(menu)).toBe(false);

  return { root, menu };
}

/** 动作观察点：click 之前布置，返回「动作确实到达」断言与清理 */
interface ActionProbe {
  assertFired: () => void;
  cleanup: () => void;
}

function probeWindowCommandEvent(eventName: string): ActionProbe {
  const listener = vi.fn();
  window.addEventListener(eventName, listener);
  return {
    assertFired: () => expect(listener).toHaveBeenCalledTimes(1),
    cleanup: () => window.removeEventListener(eventName, listener),
  };
}

function probeHiddenInputClick(selector: string): ActionProbe {
  const input = document.querySelector<HTMLInputElement>(selector);
  expect(input).not.toBeNull();
  const listener = vi.fn();
  input!.addEventListener('click', listener);
  return {
    assertFired: () => expect(listener).toHaveBeenCalledTimes(1),
    cleanup: () => input!.removeEventListener('click', listener),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// 路径维度：owned-overlay 归属查询 vs closest 兜底
// ============================================================================

const PATH_VARIANTS = [
  {
    pathName: 'owned-overlay 归属查询（有 OverlayCoordinatorProvider）',
    withProvider: true,
  },
  {
    pathName: 'closest 兜底（无 Provider，isOwnedOverlayTarget 恒 false）',
    withProvider: false,
  },
] as const;

/** 附件「更多」菜单三动作。源码顺序（canCapturePhoto=true、attachments>0）：资源库 → 拍照 → 全部清除 */
interface MoreMenuRow {
  action: string;
  pickItem: (items: HTMLElement[]) => HTMLElement | undefined;
  arm: (rendered: RenderResult) => ActionProbe;
}

const MORE_MENU_ROWS: MoreMenuRow[] = [
  {
    action: '资源库',
    pickItem: (items) => items[0],
    // handleOpenResourceLibrary → window.dispatchEvent(CHAT_TOGGLE_PANEL)
    arm: () => probeWindowCommandEvent(COMMAND_EVENTS.CHAT_TOGGLE_PANEL),
  },
  {
    action: '拍照',
    pickItem: (items) => items[1],
    // handleCameraClick → cameraInputRef.current.click()
    arm: () => probeHiddenInputClick('input[type="file"][accept="image/*"][capture]'),
  },
  {
    action: '全部清除',
    pickItem: (items) =>
      items.find((item) => item.classList.contains('app-menu-item-destructive')),
    arm: (rendered) => ({
      assertFired: () => expect(rendered.onClearAttachments).toHaveBeenCalledTimes(1),
      cleanup: () => {},
    }),
  },
];

/** 加号菜单（移动端扁平列表）动作行 */
interface PlusMenuRow {
  action: string;
  testId: string;
  arm: () => ActionProbe;
}

const PLUS_MENU_ROWS: PlusMenuRow[] = [
  {
    action: '添加文件',
    testId: 'plus-menu-add-attachment',
    // handleAddAttachmentAction → fileInputRef.current?.click()
    arm: () => probeHiddenInputClick('input[type="file"][multiple]'),
  },
  {
    action: '拍照',
    testId: 'plus-menu-camera',
    arm: () => probeHiddenInputClick('input[type="file"][accept="image/*"][capture]'),
  },
  {
    action: '资源库',
    testId: 'plus-menu-resource-library',
    arm: () => probeWindowCommandEvent(COMMAND_EVENTS.CHAT_TOGGLE_PANEL),
  },
];

describe.each(PATH_VARIANTS)('浮层 pointer 矩阵 · $pathName', ({ withProvider }) => {
  it('真外点：pointerdown 落在 body 上仍关闭附件面板（反向对照，防监听未挂载假绿）', () => {
    const { onSetPanelState } = renderInputBar(withProvider);

    firePointer(document.body, 'pointerdown');

    expect(onSetPanelState).toHaveBeenCalledWith('attachment', false);
  });

  describe('附件面板「更多」菜单三动作 pointer 链', () => {
    it.each(MORE_MENU_ROWS)(
      '$action: pointerdown 不关面板，pointerup+click 动作到达',
      ({ pickItem, arm }) => {
        // attachments 非空 → 「全部清除」项渲染，三动作齐全
        const rendered = renderInputBar(withProvider, { attachments: [plainAttachment] });
        const { root, items } = openAttachmentMoreMenu();

        const item = pickItem(items);
        expect(item).toBeDefined();

        const probe = arm(rendered);
        try {
          firePointer(item!, 'pointerdown');

          expectPanelSurvivedPointerDown(root, rendered.onSetPanelState);
          expect(item!.isConnected).toBe(true);

          firePointer(item!, 'pointerup');
          fireEvent.click(item!);

          probe.assertFired();
        } finally {
          probe.cleanup();
        }
      },
    );
  });

  describe('加号菜单 pointer 链（面板受控 prop 未回写的边界窗口）', () => {
    it.each(PLUS_MENU_ROWS)(
      '$action: pointerdown 不再触发 closeAllPanels，pointerup+click 动作到达',
      async ({ testId, arm }) => {
        const rendered = renderInputBar(withProvider);
        const { root, menu } = await openPlusMenu();

        // 产品语义（互斥）：加号菜单打开即收起组合面板。受控 prop 在本
        // harness 固定为打开（父级不回写），由此构造「面板尚未收起的同一
        // 窗口」：外点监听仍挂载，pointerdown 落在菜单 portal 上必须被
        // 双路径豁免。先清零互斥关闭的信号，再单测 pointerdown 本身。
        expect(rendered.onSetPanelState).toHaveBeenCalledWith('attachment', false);
        rendered.onSetPanelState.mockClear();

        const item = within(menu).getByTestId(testId);

        const probe = arm();
        try {
          firePointer(item, 'pointerdown');

          expectPanelSurvivedPointerDown(root, rendered.onSetPanelState);
          expect(item.isConnected).toBe(true);

          firePointer(item, 'pointerup');
          fireEvent.click(item);

          probe.assertFired();
        } finally {
          probe.cleanup();
        }

        // 行内反向对照：同一状态下真外点仍触发关闭，证明上面的「未被关闭」
        // 不是监听丢失造成的假绿
        firePointer(document.body, 'pointerdown');
        expect(rendered.onSetPanelState).toHaveBeenCalledWith('attachment', false);
      },
    );
  });

  it('合成 [data-app-menu-id] body portal 节点内 pointerdown 不关面板（判定兜底，不依赖真实菜单渲染）', () => {
    const { onSetPanelState } = renderInputBar(withProvider);

    const portalNode = document.createElement('div');
    portalNode.setAttribute('data-app-menu-id', 'synthetic-menu');
    const innerButton = document.createElement('button');
    portalNode.appendChild(innerButton);
    document.body.appendChild(portalNode);
    try {
      // 命中 portal 内层节点（closest / selector 归属均需向上找 [data-app-menu-id]）
      firePointer(innerButton, 'pointerdown');

      expect(onSetPanelState).not.toHaveBeenCalledWith('attachment', false);
    } finally {
      portalNode.remove();
    }
  });
});

// ============================================================================
// owned-overlay 路径隔离：只有归属查询能豁免的形态（closest 必不命中）
// ============================================================================

describe('owned-overlay 路径隔离（仅 Provider 变体可测）', () => {
  it('element 登记的无 data-app-menu-id 浮层：pointerdown 不关面板（豁免只可能来自归属查询）', () => {
    const { onSetPanelState, getCoordinator } = renderInputBar(true);
    const coordinator = getCoordinator();
    expect(coordinator).not.toBeNull();

    const overlay = document.createElement('div');
    const innerButton = document.createElement('button');
    overlay.appendChild(innerButton);
    document.body.appendChild(overlay);
    // 以 element 引用补登到 Composer 的 ownerId 下：节点不带 data-app-menu-id，
    // 谓词末条 closest 兜底不可能命中 → 面板存活只能证明 isOwnedOverlayTarget 生效
    const unregister = coordinator!.registerOwnedOverlay({
      ownerId: COMPOSER_OWNER_ID,
      element: overlay,
    });
    try {
      expect(overlay.closest('[data-app-menu-id]')).toBeNull();

      firePointer(innerButton, 'pointerdown');

      expect(onSetPanelState).not.toHaveBeenCalledWith('attachment', false);
    } finally {
      unregister();
      overlay.remove();
    }
  });

  it('对照：同形态浮层不登记时 pointerdown 关闭面板（证明上一条的豁免确实来自登记）', () => {
    const { onSetPanelState } = renderInputBar(true);

    const overlay = document.createElement('div');
    const innerButton = document.createElement('button');
    overlay.appendChild(innerButton);
    document.body.appendChild(overlay);
    try {
      firePointer(innerButton, 'pointerdown');

      expect(onSetPanelState).toHaveBeenCalledWith('attachment', false);
    } finally {
      overlay.remove();
    }
  });

  it('登记窗口纯函数边界：登记期间 selector 命中归属，注销后同一 target 查询落空', () => {
    const store = createOwnedOverlayStore();
    const portalNode = document.createElement('div');
    portalNode.setAttribute('data-app-menu-id', 'm1');
    const innerButton = document.createElement('button');
    portalNode.appendChild(innerButton);
    document.body.appendChild(portalNode);
    try {
      const unregister = registerOwnedOverlayEntry(store, {
        ownerId: COMPOSER_OWNER_ID,
        selector: '[data-app-menu-id]',
      });

      expect(isEventInsideOwnedOverlay(store, COMPOSER_OWNER_ID, innerButton)).toBe(true);
      // 归属按 ownerId 隔离：别的 owner 查不到 Composer 的登记
      expect(isEventInsideOwnedOverlay(store, 'someone-else', innerButton)).toBe(false);

      unregister();
      // 注销后（面板关闭窗口外）归属查询落空 → 产品侧此时只剩 closest 兜底
      expect(isEventInsideOwnedOverlay(store, COMPOSER_OWNER_ID, innerButton)).toBe(false);
    } finally {
      portalNode.remove();
    }
  });
});

// ============================================================================
// source 契约：双路径判定与动作接线（锁形态，防悄悄退化）
// ============================================================================

describe('外点判定双路径 source 契约', () => {
  const readSource = (relPath: string): string =>
    readFileSync(resolve(process.cwd(), relPath), 'utf-8');

  const inputBarSource = readSource('src/features/chat/components/input-bar/InputBarUI.tsx');

  it('外点关闭监听挂 document pointerdown 且 handler 走统一谓词', () => {
    expect(inputBarSource).toContain(
      "document.addEventListener('pointerdown', handleClickOutside)",
    );

    const handlerMatch = inputBarSource.match(
      /const handleClickOutside[\s\S]*?closeAllPanels\(\);\s*\};/,
    );
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch![0]).toContain('isWithinComposerTerritory(e.target as Node)');
  });

  it('谓词保留双路径：归属查询在前、closest 兜底在后', () => {
    const predicateStart = inputBarSource.indexOf('const isWithinComposerTerritory');
    expect(predicateStart).toBeGreaterThan(-1);

    const ownedIdx = inputBarSource.indexOf(
      'isOwnedOverlayTarget(COMPOSER_OVERLAY_OWNER_ID, node)',
      predicateStart,
    );
    const closestIdx = inputBarSource.indexOf(
      'closest(COMPOSER_OWNED_OVERLAY_SELECTOR)',
      predicateStart,
    );
    expect(ownedIdx).toBeGreaterThan(predicateStart);
    expect(closestIdx).toBeGreaterThan(ownedIdx);
    // 双条件都要落在谓词体内（谓词整体不超过千字符量级，防匹配漂移到别处）
    expect(closestIdx - predicateStart).toBeLessThan(1000);
  });

  it('常量与测试假设同步：ownerId 与登记 selector', () => {
    expect(inputBarSource).toMatch(
      new RegExp(`const COMPOSER_OVERLAY_OWNER_ID = '${COMPOSER_OWNER_ID}';`),
    );
    expect(inputBarSource).toMatch(
      /const COMPOSER_OWNED_OVERLAY_SELECTOR = '\[data-app-menu-id\]';/,
    );
  });

  it('归属登记以面板打开为窗口（hasAnyPanelOpen 门控 + effect cleanup 注销）', () => {
    expect(inputBarSource).toMatch(
      /if \(!hasAnyPanelOpen\) return;\s*return registerOwnedOverlay\(\{\s*ownerId: COMPOSER_OVERLAY_OWNER_ID,\s*selector: COMPOSER_OWNED_OVERLAY_SELECTOR,\s*\}\);/,
    );
  });

  it('无 Provider 回退语义 fail-empty：isOwnedOverlayTarget 恒 false（closest 兜底因此不可删）', () => {
    const coordinatorSource = readSource('src/components/shared/OverlayCoordinator.tsx');
    expect(coordinatorSource).toContain('isOwnedOverlayTarget: () => false');
  });

  it('附件「更多」菜单三动作接线到真实 handler', () => {
    const attachmentPanelSource = readSource(
      'src/features/chat/components/input-bar/AttachmentPanelBody.tsx',
    );
    expect(attachmentPanelSource).toMatch(/onClick=\{onOpenResourceLibrary\}/);
    expect(attachmentPanelSource).toMatch(/onClick=\{onOpenCamera\}/);
    expect(attachmentPanelSource).toMatch(/destructive\s*onClick=\{onClearAttachments\}/);
  });

  it('加号菜单动作项接线到回调（testid 与 onClick 同点位）', () => {
    const plusMenuSource = readSource(
      'src/features/chat/components/input-bar/ComposerPlusMenu.tsx',
    );
    expect(plusMenuSource).toMatch(
      /onClick=\{onAddAttachment\}\s*data-testid="plus-menu-add-attachment"/,
    );
    expect(plusMenuSource).toMatch(
      /onClick=\{onOpenCamera\}\s*data-testid="plus-menu-camera"/,
    );
    expect(plusMenuSource).toMatch(
      /onClick=\{onOpenResourceLibrary\}\s*data-testid="plus-menu-resource-library"/,
    );
  });

  it('InputBarUI 把菜单动作接到隐藏 input / 命令事件（矩阵动作观察点的真实性）', () => {
    expect(inputBarSource).toMatch(
      /const handleAddAttachmentAction[\s\S]{0,200}fileInputRef\.current\?\.click\(\)/,
    );
    expect(inputBarSource).toMatch(
      /const handleOpenResourceLibrary[\s\S]{0,240}COMMAND_EVENTS\.CHAT_TOGGLE_PANEL/,
    );
    expect(inputBarSource).toMatch(
      /const handleCameraClick[\s\S]{0,240}cameraInputRef\.current\.click\(\)/,
    );
  });
});
