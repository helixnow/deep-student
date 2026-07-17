/**
 * Obsidian-compatible Callout blocks for Crepe / Milkdown.
 *
 * Syntax (roundtrip-safe Markdown):
 *   > [!note] Optional title
 *   > body…
 *
 * Wiring agent should register via:
 *   crepe.editor.use(calloutPlugin())
 * and import this module (CSS side-effect) before create().
 */

import type { MilkdownPlugin } from '@milkdown/ctx';

import { calloutFullLineInputRule, calloutInputRule } from './inputRule';
import { calloutSchema } from './schema';
import { remarkCalloutPlugin } from './remark';
import { calloutView } from './view';

import './style.css';

export {
  applyCalloutInputRule,
  applyFullLineCalloutInputRule,
  calloutFullLineInputRule,
  calloutInputRule,
} from './inputRule';
export { promoteBlockquoteToCallout, remarkCalloutPlugin } from './remark';
export { CALLOUT_DATA_TYPE, calloutSchema } from './schema';
export {
  CALLOUT_MARKER_RE,
  CALLOUT_TYPES,
  CALLOUT_TYPE_SET,
  isCalloutType,
  nextCalloutType,
  normalizeCalloutType,
  parseCalloutMarker,
  type CalloutType,
  type ParsedCalloutMarker,
} from './types';
export { calloutView } from './view';

/** Unified plugin entry — does not self-register; caller must `editor.use(...)`. */
export function calloutPlugin(): MilkdownPlugin[] {
  return [
    remarkCalloutPlugin,
    calloutSchema,
    calloutInputRule,
    calloutFullLineInputRule,
    calloutView,
  ].flat();
}
