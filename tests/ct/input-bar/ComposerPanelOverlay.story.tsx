import React from 'react';
import { InputBarUI } from '@/features/chat/components/input-bar/InputBarUI';
import { createDefaultPanelStates } from '@/features/chat/core/types/common';

export function InputBarWithOpenMcpPanel() {
  return (
    <div style={{ width: 960, minHeight: 720, padding: 48 }}>
      <div style={{ height: 360 }} />
      <InputBarUI
        inputValue=""
        canSend={false}
        canAbort={false}
        isStreaming={false}
        attachments={[]}
        panelStates={{ ...createDefaultPanelStates(), mcp: true }}
        onInputChange={() => undefined}
        onSend={() => undefined}
        onAbort={() => undefined}
        onAddAttachment={() => undefined}
        onUpdateAttachment={() => undefined}
        onRemoveAttachment={() => undefined}
        onClearAttachments={() => undefined}
        onSetPanelState={() => undefined}
        placeholder="输入消息"
        renderMcpPanel={() => (
          <div data-testid="mcp-panel-content" style={{ height: 760 }}>
            MCP panel content
          </div>
        )}
      />
    </div>
  );
}

export function InputBarWithConflictingComposerPanels() {
  return (
    <div style={{ width: 960, minHeight: 720, padding: 48 }}>
      <div style={{ height: 360 }} />
      <InputBarUI
        inputValue=""
        canSend={false}
        canAbort={false}
        isStreaming={false}
        attachments={[]}
        panelStates={{ ...createDefaultPanelStates(), mcp: true, skill: true }}
        onInputChange={() => undefined}
        onSend={() => undefined}
        onAbort={() => undefined}
        onAddAttachment={() => undefined}
        onUpdateAttachment={() => undefined}
        onRemoveAttachment={() => undefined}
        onClearAttachments={() => undefined}
        onSetPanelState={() => undefined}
        placeholder="输入消息"
        renderMcpPanel={() => <div data-testid="mcp-panel-content">MCP panel content</div>}
        renderSkillPanel={() => <div data-testid="skill-panel-content">Skill panel content</div>}
      />
    </div>
  );
}
