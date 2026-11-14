/**
 * FE-B7: entries logged through each panel module's public log functions (debug channels, the `window` debug globals)
 * reach the mounted panel, and clearing empties it. The panels receive them from their own module, not through
 * `window` CustomEvents.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { debugMasterSwitch } from '../debugMasterSwitch';
// Loaded with the file rather than inside each case: transforming the multi-agent panel's chat-core imports alone
// takes most of a case's 5 s budget on a loaded machine.
import * as crepeEditorPanel from '../plugins/CrepeEditorDebugPlugin';
import * as crepeImageUploadPanel from '../plugins/CrepeImageUploadDebugPlugin';
import * as multiAgentPanel from '../plugins/MultiAgentDebugPlugin';
import * as pdfMultimodalPanel from '../plugins/PdfMultimodalDebugPlugin';
import * as sessionLoadFlowPanel from '../plugins/SessionLoadFlowDebugPlugin';
import * as chatAnkiWorkflowPanel from '../plugins/ChatAnkiWorkflowDebugPlugin';
import * as templateDesignerPanel from '../plugins/TemplateDesignerWorkflowDebugPlugin';
import * as subagentFlowPanel from '../plugins/SubagentMessageFlowDebugPlugin';
import { emitCrepeDebug } from '@/shared/debug/channels/crepeEditor';
import { emitImageUploadDebug } from '@/shared/debug/channels/crepeImageUpload';
import { emitChatAnkiLifecycle } from '@/shared/debug/channels/chatAnki';
import { emitTemplateDesignerLifecycle, emitTemplateDesignerToolEvent } from '@/shared/debug/channels/templateDesigner';

vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));

const props = { visible: true, isActive: true, isActivated: true, isActivatedInitially: true, onClose: () => undefined };

beforeAll(() => {
  debugMasterSwitch.enable();
});

afterAll(() => {
  debugMasterSwitch.disable();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount({ default: Panel }: { default: React.ComponentType<any> }) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Panel {...props} />);
  });
  return view.container;
}

async function step(fn: () => void) {
  await act(async () => {
    fn();
  });
}

describe('debug panel log delivery (FE-B7)', () => {
  it('Crepe editor: emitCrepeDebug through the crepe-editor channel', async () => {
    const container = await mount(crepeEditorPanel);
    await step(() => emitCrepeDebug('lifecycle', 'info', 'crepe-editor-delivery-probe'));
    expect(container.textContent).toContain('crepe-editor-delivery-probe');
  });

  it('Crepe image upload: emitImageUploadDebug through the crepe-image-upload channel', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const container = await mount(crepeImageUploadPanel);
    await step(() => emitImageUploadDebug('upload_start', 'info', 'crepe-image-upload-delivery-probe'));
    expect(container.textContent).toContain('crepe-image-upload-delivery-probe');
  });

  it('Multi-agent: logMultiAgent and clearMultiAgentLogs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const container = await mount(multiAgentPanel);
    const { logMultiAgent, clearMultiAgentLogs } = multiAgentPanel;
    await step(() => clearMultiAgentLogs());
    expect(container.textContent).toContain('日志 (0)');
    await step(() => logMultiAgent('workspace', 'multi-agent-delivery-probe', {}));
    await step(() => logMultiAgent('workspace', 'multi-agent-delivery-probe', {}));
    expect(container.textContent).toContain('日志 (2)');
    await step(() => clearMultiAgentLogs());
    expect(container.textContent).toContain('日志 (0)');
  });

  it('PDF multimodal: pdfMultimodalDebug.log and clear', async () => {
    const container = await mount(pdfMultimodalPanel);
    const { pdfMultimodalDebug } = pdfMultimodalPanel;
    await step(() => pdfMultimodalDebug.log('pdf-multimodal-delivery-probe'));
    expect(container.textContent).toContain('pdf-multimodal-delivery-probe');
    await step(() => pdfMultimodalDebug.clear());
    expect(container.textContent).not.toContain('pdf-multimodal-delivery-probe');
  });

  it('Session load flow: logSessionLoadFlow and captureStateSnapshot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const container = await mount(sessionLoadFlowPanel);
    const { logSessionLoadFlow, captureStateSnapshot } = sessionLoadFlowPanel;
    await step(() => logSessionLoadFlow('ui_render', 'session-load-delivery-probe', {}));
    expect(container.textContent).toContain('session-load-delivery-probe');
    const snapshots = Number(/(\d+) 个快照/.exec(container.textContent ?? '')?.[1]);
    await step(() => captureStateSnapshot({ timestamp: '12:00:00.000', sessionId: 'session-snapshot-probe' } as never));
    expect(container.textContent).toContain(`${snapshots + 1} 个快照`);
    expect(container.textContent).toContain('session-snapshot-probe');
  });

  it('ChatAnki workflow: emitChatAnkiLifecycle through the chatanki channel, with the window event detail', async () => {
    const container = await mount(chatAnkiWorkflowPanel);
    await step(() => emitChatAnkiLifecycle({ level: 'warn', phase: 'render:ui-source-check', summary: 'chatanki-channel-delivery-probe', blockId: 'blk-1' }));
    expect(container.textContent).toContain('chatanki-channel-delivery-probe');
    expect(container.textContent).toContain('render:ui-source-check');
    debugMasterSwitch.disable();
    await step(() => emitChatAnkiLifecycle({ level: 'info', phase: 'system', summary: 'chatanki-channel-while-switch-off' }));
    debugMasterSwitch.enable();
    expect(container.textContent).not.toContain('chatanki-channel-while-switch-off');
  });

  it('Template designer: emitTemplateDesignerLifecycle and emitTemplateDesignerToolEvent through the template-designer channel', async () => {
    const container = await mount(templateDesignerPanel);
    await step(() => emitTemplateDesignerLifecycle({ level: 'info', phase: 'render:template', summary: 'template-designer-channel-delivery-probe' }));
    await step(() =>
      emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'end', toolName: 'builtin-template_get', toolOutput: { status: 'ok', templateId: 'tpl-probe' } }),
    );
    expect(container.textContent).toContain('template-designer-channel-delivery-probe');
    expect(container.textContent).toContain('← template_get | status=ok | templateId=tpl-probe');
  });

  it('Subagent message flow: window.__subagentFlowLog', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const container = await mount(subagentFlowPanel);
    const log = (window as unknown as { __subagentFlowLog: (phase: string, action: string, data: object) => void }).__subagentFlowLog;
    await step(() => log('spawn', 'subagent-flow-delivery-probe', {}));
    expect(container.textContent).toContain('subagent-flow-delivery-probe');
  });
});
