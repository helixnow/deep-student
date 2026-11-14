/** Rust tool_descriptors.rs:681-725; one lookup table for L04 dispatch and policy consumers. */
import { BUILTIN_DESCRIPTORS, type ToolDescriptor, type GrantsScopeHint } from '../../../kernel/agent-tool-descriptors.ts';
export { BUILTIN_DESCRIPTORS, isPtcAllowed } from '../../../kernel/agent-tool-descriptors.ts';
const descriptors = new Map(BUILTIN_DESCRIPTORS.map(descriptor => [descriptor.name, descriptor]));
export function lookupToolDescriptor(name: string): ToolDescriptor | null { return descriptors.get(name) ?? null; }
const stripBuiltin = (name: string) => name.startsWith('builtin-') ? name.slice(8) : name;
export function isHeadlessReadonly(name: string): boolean { return lookupToolDescriptor(stripBuiltin(name))?.headlessAllowed ?? false; }
export function grantsScopeHint(name: string): GrantsScopeHint | null { return lookupToolDescriptor(stripBuiltin(name))?.grantsScopeHint ?? null; }
