/**
 * FE-B7 evidence: the debug panel inventory of a development build.
 *
 * `collectInventory` and `renderHost` are the assembly under test: the goldens were captured from the `PLUGINS`
 * literal of DebugPanelHost before FE-B7; now the list is the `debug.panels` slot of the production UI assembly
 * (`dstu.ui.debug`, development build). Everything else (the fields kept per panel, the home
 * screen DOM at desktop and phone width, which panel component each home card opens, which component each id opens
 * through `DSTU_DEBUG_PLUGIN` and the props it receives) must stay equal to the goldens captured before the change.
 *
 * Panel modules are replaced by markers so the test sees exactly which module an entry renders.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { serializeDom } from '@/ui-plugins/testing/dom-snapshot';
import { debugMasterSwitch } from '../debugMasterSwitch';
import type { DebugPanel } from '@/ui-plugins/official/debug/api';
import { pinDefaultLocaleForFile } from './defaultLocale';

const { panelModule } = vi.hoisted(() => ({
  panelModule: async (name: string) => {
    const { createElement } = await import('react');
    const Panel = (props: Record<string, unknown>) =>
      createElement('div', {
        'data-debug-panel': name,
        'data-props': JSON.stringify({
          visible: props.visible,
          isActive: props.isActive,
          isActivated: props.isActivated,
          currentStreamId: props.currentStreamId,
          onClose: typeof props.onClose,
        }),
      });
    return { default: Panel };
  },
}));

vi.mock('../plugins/DeepSeekOcrDebugPlugin', () => panelModule('DeepSeekOcrDebugPlugin'));
vi.mock('../plugins/WebSearchDebugPlugin', () => panelModule('WebSearchDebugPlugin'));
vi.mock('../plugins/UnifiedDragDropDebugPlugin', () => panelModule('UnifiedDragDropDebugPlugin'));
vi.mock('../plugins/AnkiGenerationDebugPlugin', () => panelModule('AnkiGenerationDebugPlugin'));
vi.mock('../plugins/McpDebugPlugin', () => panelModule('McpDebugPlugin'));
vi.mock('../plugins/ImageAttachmentInspectorPlugin', () => panelModule('ImageAttachmentInspectorPlugin'));
vi.mock('../plugins/ImagePreviewDebugPlugin', () => panelModule('ImagePreviewDebugPlugin'));
vi.mock('../plugins/LayoutDebugPlugin', () => panelModule('LayoutDebugPlugin'));
vi.mock('../plugins/FloatingPanelDebugPlugin', () => panelModule('FloatingPanelDebugPlugin'));
vi.mock('../plugins/NotesTypographyDebugPlugin', () => panelModule('NotesTypographyDebugPlugin'));
vi.mock('../plugins/NotesOutlineDebugPlugin', () => panelModule('NotesOutlineDebugPlugin'));
vi.mock('../plugins/CrepeEditorDebugPlugin', () => panelModule('CrepeEditorDebugPlugin'));
vi.mock('../plugins/CrepeDragDropDebugPlugin', () => panelModule('CrepeDragDropDebugPlugin'));
vi.mock('../plugins/CrepeImageUploadDebugPlugin', () => panelModule('CrepeImageUploadDebugPlugin'));
vi.mock('../plugins/EssayGradingTooltipDebugPlugin', () => panelModule('EssayGradingTooltipDebugPlugin'));
vi.mock('../plugins/SessionLoadFlowDebugPlugin', () => panelModule('SessionLoadFlowDebugPlugin'));
vi.mock('../plugins/SessionSwitchPerfDebugPlugin', () => panelModule('SessionSwitchPerfDebugPlugin'));
vi.mock('../plugins/ChatV2ImagePreviewDebugPlugin', () => panelModule('ChatV2ImagePreviewDebugPlugin'));
vi.mock('../plugins/MultiVariantDebugPlugin', () => panelModule('MultiVariantDebugPlugin'));
vi.mock('../plugins/MultiAgentDebugPlugin', () => panelModule('MultiAgentDebugPlugin'));
vi.mock('../plugins/SubagentTestPlugin', () => panelModule('SubagentTestPlugin'));
vi.mock('../plugins/SubagentMessageFlowDebugPlugin', () => panelModule('SubagentMessageFlowDebugPlugin'));
vi.mock('../plugins/ThinkingBlockDebugPlugin', () => panelModule('ThinkingBlockDebugPlugin'));
vi.mock('../plugins/MarkdownStreamingProfilerPlugin', () => panelModule('MarkdownStreamingProfilerPlugin'));
vi.mock('../plugins/DstuDebugPlugin', () => panelModule('DstuDebugPlugin'));
vi.mock('../plugins/AttachmentInjectionDebugPlugin', () => panelModule('AttachmentInjectionDebugPlugin'));
vi.mock('../plugins/AttachmentOcrRequestAuditPlugin', () => panelModule('AttachmentOcrRequestAuditPlugin'));
vi.mock('../plugins/MediaProcessingDebugPlugin', () => panelModule('MediaProcessingDebugPlugin'));
vi.mock('../plugins/PdfMultimodalDebugPlugin', () => panelModule('PdfMultimodalDebugPlugin'));
vi.mock('../plugins/FinderDragDropDebugPlugin', () => panelModule('FinderDragDropDebugPlugin'));
vi.mock('../plugins/SelectionBoxDebugPlugin', () => panelModule('SelectionBoxDebugPlugin'));
vi.mock('../plugins/PageLifecycleDebugPlugin', () => panelModule('PageLifecycleDebugPlugin'));
vi.mock('../plugins/EditRetryDebugPlugin', () => panelModule('EditRetryDebugPlugin'));
vi.mock('../plugins/ChatAnkiWorkflowDebugPlugin', () => panelModule('ChatAnkiWorkflowDebugPlugin'));
vi.mock('../plugins/TemplateDesignerWorkflowDebugPlugin', () => panelModule('TemplateDesignerWorkflowDebugPlugin'));
vi.mock('../plugins/MindMapBlurHoverDebugPlugin', () => panelModule('MindMapBlurHoverDebugPlugin'));
vi.mock('../plugins/AttachmentPipelineTestPlugin', () => panelModule('AttachmentPipelineTestPlugin'));
vi.mock('../plugins/ChatInteractionTestPlugin', () => panelModule('ChatInteractionTestPlugin'));
vi.mock('../plugins/CitationTestPlugin', () => panelModule('CitationTestPlugin'));
vi.mock('../plugins/MultiVariantTestPlugin', () => panelModule('MultiVariantTestPlugin'));
vi.mock('../plugins/WorkspaceOrchestrationTestPlugin', () => panelModule('WorkspaceOrchestrationTestPlugin'));
vi.mock('../plugins/ToolCallLifecycleDebugPlugin', () => panelModule('ToolCallLifecycleDebugPlugin'));
vi.mock('../plugins/ExamSheetProcessingDebugPlugin', () => panelModule('ExamSheetProcessingDebugPlugin'));
vi.mock('../plugins/QuestionImportDebugPlugin', () => panelModule('QuestionImportDebugPlugin'));
vi.mock('../plugins/ChatAnkiIntegrationTestPlugin', () => panelModule('ChatAnkiIntegrationTestPlugin'));
vi.mock('@/dev/devtools', () => ({ toggleDevtools: vi.fn(async () => null) }));

const GOLDEN_DIR = 'src/debug-panel/__tests__/__golden__';
const CAPTURE = process.env.FE_B7_CAPTURE_GOLDEN === '1';
const homeCards = JSON.parse(fs.readFileSync(`${GOLDEN_DIR}/home-cards.dev.json`, 'utf8')) as Array<{
  card: string;
  id: string;
  component: string;
}>;

type InventoryEntry = {
  order: number;
  id: string;
  groupId: string;
  component: string;
  labelKey: string;
  descriptionKey: string;
  labelDefault: string | null;
  descriptionDefault: string | null;
};

let kernel: UiKernel;

/** Assembly: the `debug.panels` slot of the production UI assembly in a development build. */
async function collectInventory(): Promise<InventoryEntry[]> {
  return kernel.slots.list('debug.panels').map((entry, order) => {
    const panel = entry.value as DebugPanel;
    const mounted = render(React.createElement(panel.component, { visible: true, isActive: true, isActivated: true, onClose: () => undefined }));
    const component = mounted.container.querySelector<HTMLElement>('[data-debug-panel]')?.dataset.debugPanel ?? '?';
    mounted.unmount();
    return {
      order,
      id: entry.id,
      groupId: panel.groupId,
      component,
      labelKey: panel.labelKey,
      descriptionKey: panel.descriptionKey,
      labelDefault: panel.labelDefault ?? null,
      descriptionDefault: panel.descriptionDefault ?? null,
    };
  });
}

/** Assembly: the host as GlobalDebugPanel mounts it in a development build (inside the app UI kernel). */
async function renderHost() {
  const { default: DebugPanelHost } = await import('../DebugPanelHost');
  return render(
    <UiKernelProvider kernel={kernel}>
      <DebugPanelHost visible onClose={() => undefined} currentStreamId="stream-1" />
    </UiKernelProvider>,
  );
}

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, current, { flag: 'wx' });
  }
  return fs.readFileSync(file, 'utf8');
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function portal(): HTMLElement {
  const el = document.getElementById('dstu-debugger-portal');
  if (!el) throw new Error('debug panel portal not mounted');
  return el;
}

function renderedPanels() {
  return Array.from(portal().querySelectorAll<HTMLElement>('[data-debug-panel]')).map((el) => ({
    component: el.dataset.debugPanel,
    shown: !el.parentElement?.className.split(' ').includes('hidden'),
    props: JSON.parse(el.dataset.props ?? '{}'),
  }));
}

// The home screen orders cards with `label.localeCompare`.
pinDefaultLocaleForFile();

beforeAll(async () => {
  await import('../DebugPanelHost');
  const { createAppUiKernel } = await import('@/ui-kernel/bootstrap');
  kernel = await createAppUiKernel();
}, 30_000);

afterAll(async () => {
  await kernel.dispose();
});

beforeEach(() => {
  localStorage.clear();
  debugMasterSwitch.enable();
  setViewport(1024, 768);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('debug panel inventory (FE-B7)', () => {
  it('keeps every panel entry with its id, group, component, keys and default texts', async () => {
    const current = `${JSON.stringify(await collectInventory(), null, 2)}\n`;
    expect(current).toBe(golden('inventory.dev.json', current));
  });

  it.each([
    ['desktop', 1024, 768],
    ['mobile', 390, 844],
  ])('renders the same home screen at %s width', async (name, width, height) => {
    setViewport(width, height);
    await renderHost();
    const current = `${serializeDom(portal())}\n`;
    expect(current).toBe(golden(`home.${name}.txt`, current));
  });

  // Each card gets its own timeout budget, without replaying all preceding clicks.
  it.each(homeCards.map((entry, index) => ({ ...entry, index })))('opens the same panel component from home card $card', async ({ index }) => {
    // Preserve the accumulated activation state of the original sequential walk.
    localStorage.setItem('DSTU_DEBUG_ACTIVATED', JSON.stringify(homeCards.slice(0, index).map((entry) => entry.id)));
    await renderHost();
    const homeLabel = portal().querySelector('button')?.textContent ?? '';
    const cards = Array.from(portal().querySelectorAll<HTMLElement>('[class*="group relative rounded-xl"]'));
    expect(cards).toHaveLength(homeCards.length);
    const card = cards[index];
    const title = card.querySelector('h3')?.textContent ?? '';
    const before = new Set<string>(JSON.parse(localStorage.getItem('DSTU_DEBUG_ACTIVATED') ?? '[]'));
    fireEvent.click(within(card).getByText('打开'));
    const after: string[] = JSON.parse(localStorage.getItem('DSTU_DEBUG_ACTIVATED') ?? '[]');
    const shown = renderedPanels().filter((panel) => panel.shown);
    // Substitute this card's actual result; all rows are exercised by it.each.
    const opened: Array<{ card: string; id: string; component: string | undefined }> = [...homeCards];
    opened[index] = { card: title, id: after.filter((id) => !before.has(id)).join(','), component: shown[0]?.component };
    expect(shown).toHaveLength(1);
    fireEvent.click(screen.getByText(homeLabel));
    const current = `${JSON.stringify(opened, null, 2)}\n`;
    expect(current).toBe(golden('home-cards.dev.json', current));
  });

  it('opens the inventory component for every id requested through DSTU_DEBUG_PLUGIN, with the host props', async () => {
    const inventory = JSON.parse(fs.readFileSync(`${GOLDEN_DIR}/inventory.dev.json`, 'utf8')) as InventoryEntry[];
    const opened: Array<{ id: string; panels: ReturnType<typeof renderedPanels> }> = [];
    for (const entry of inventory) {
      localStorage.clear();
      localStorage.setItem('DSTU_DEBUG_PLUGIN', entry.id);
      await act(async () => {
        await renderHost();
      });
      opened.push({ id: entry.id, panels: renderedPanels() });
      expect(renderedPanels()).toEqual([
        { component: entry.component, shown: true, props: { visible: true, isActive: true, isActivated: true, currentStreamId: 'stream-1', onClose: 'function' } },
      ]);
      cleanup();
    }
    const current = `${JSON.stringify(opened, null, 2)}\n`;
    expect(current).toBe(golden('requested.dev.json', current));
  });
});
