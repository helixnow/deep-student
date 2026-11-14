import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/TemplateDesignerWorkflowDebugPlugin';

export const TEMPLATE_DESIGNER_DEBUG_CHANNEL = 'template-designer';

const channel = debugChannel<Pick<typeof Panel, 'recordTemplateDesignerToolEvent' | 'recordTemplateDesignerLifecycle'>>(
  TEMPLATE_DESIGNER_DEBUG_CHANNEL,
);

/** Same detail as the `template-designer-debug-tool-block` window event; a no-op in production builds. */
export const emitTemplateDesignerToolEvent = channel.emitter('recordTemplateDesignerToolEvent');
/** Same detail as the `template-designer-debug-lifecycle` window event; a no-op in production builds. */
export const emitTemplateDesignerLifecycle = channel.emitter('recordTemplateDesignerLifecycle');
