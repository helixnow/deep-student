export {
  BUILTIN_DESCRIPTORS, DEFAULT_TOOL_TIMEOUT_SECS, NO_TIMEOUT_SECS,
  isHeadlessReadonly, isPtcAllowed, lookupToolDescriptor,
  type GrantsScopeHint, type SideEffectClass, type ToolDescriptor, type ToolSensitivity,
} from '../../../kernel/agent-tool-descriptors.ts';

/** headless.rs:545–562: wire names keep builtin- except the bare meta tools. */
export function headlessWireName(bareName: string): string {
  return bareName === 'attempt_completion' || bareName.startsWith('todo_')
    ? bareName
    : `builtin-${bareName}`;
}
