import { describe, expect, it, vi } from 'vitest';
import {
  TEMPLATE_DESIGNER_LIFECYCLE_EVENT,
  TEMPLATE_DESIGNER_TOOL_EVENT,
  buildTemplateToolSummary,
  emitTemplateDesignerLifecycle,
  emitTemplateDesignerToolEvent,
  isTemplateDesignerToolName,
  normalizeToolName,
} from '@/chat-v2/debug/templateDesignerDebug';

describe('templateDesignerDebug', () => {
  it('normalizes tool names from multiple namespaces', () => {
    expect(normalizeToolName('builtin-template_list')).toBe('template_list');
    expect(normalizeToolName('mcp_template_update')).toBe('template_update');
    expect(normalizeToolName('mcp.tools.template_fork')).toBe('template_fork');
    expect(normalizeToolName('tools.template_preview')).toBe('template_preview');
  });

  it('detects template designer tools', () => {
    expect(isTemplateDesignerToolName('builtin-template_list')).toBe(true);
    expect(isTemplateDesignerToolName('template_delete')).toBe(true);
    expect(isTemplateDesignerToolName('chatanki_run')).toBe(false);
  });

  it('builds concise summary for start/end/error phases', () => {
    const start = buildTemplateToolSummary('template_update', 'start', {
      expectedVersion: '1.0.0',
      templateId: 'tpl-1',
    }, undefined);
    const end = buildTemplateToolSummary('template_update', 'end', undefined, {
      status: 'ok',
      templateId: 'tpl-1',
    });
    const error = buildTemplateToolSummary('template_update', 'error', undefined, undefined, 'boom');

    expect(start).toContain('→ template_update');
    expect(start).toContain('expectedVersion=1.0.0');
    expect(end).toContain('← template_update');
    expect(end).toContain('templateId=tpl-1');
    expect(error).toContain('✗ template_update');
    expect(error).toContain('boom');
  });

  it('dispatches browser events for tool/lifecycle logs', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');

    emitTemplateDesignerToolEvent({
      type: 'tool_call',
      phase: 'start',
      toolName: 'builtin-template_preview',
      blockId: 'block-1',
    });
    emitTemplateDesignerLifecycle({
      level: 'info',
      phase: 'block:state',
      summary: 'status=running',
      blockId: 'block-1',
    });

    expect(spy).toHaveBeenCalledWith(expect.any(CustomEvent));
    expect((spy.mock.calls[0]?.[0] as Event).type).toBe(TEMPLATE_DESIGNER_TOOL_EVENT);
    expect((spy.mock.calls[1]?.[0] as Event).type).toBe(TEMPLATE_DESIGNER_LIFECYCLE_EVENT);
  });
});
