import type { ComponentType } from 'react';
import type { BlockComponentProps } from '@/features/chat/registry/blockRegistry';

/**
 * Where a tool result view goes inside the mcp_tool block:
 * - `block`: replaces the whole tool block (todo list, paper download progress, completion card);
 * - `output`: replaces the generic output view of the success state;
 * - `actions`: appended below the output of the success state (open file, open note…).
 */
export type ChatToolResultPlacement = 'block' | 'output' | 'actions';

export interface ChatToolResultProps extends BlockComponentProps {
  /** The tool name as the backend sent it (prefixes kept). */
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
}

/**
 * `chat.toolResults` value; the contribution key is the tool's base name (without `builtin-`).
 * Unmatched tools, and contributions whose `when` returns false, fall back to the generic view.
 */
export interface ChatToolResultContribution {
  placement: ChatToolResultPlacement;
  component: ComponentType<ChatToolResultProps>;
  when?: (props: ChatToolResultProps) => boolean;
  /**
   * `exact` (default): the key itself or `builtin-<key>`.
   * `qualified`: additionally `builtin:<key>`, `mcp_<key>`, `mcp.tools.<key>` and `<namespace>.<key>`.
   */
  match?: 'exact' | 'qualified';
}

declare module '../slot-map' {
  interface SlotMap {
    'chat.toolResults': ChatToolResultContribution;
  }
}
