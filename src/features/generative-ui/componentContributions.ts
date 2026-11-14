/**
 * Generative UI components as UI plugin contributions (FE-B6): keyed slot `genui.components`, key = block type.
 *
 * The built-in components load with the renderer and announce themselves here; the official UI plugin
 * `dstu.ui.genui` declares the slot and contributes them. GenerativeUIRenderer resolves block types from the slot when
 * a UI kernel is present and from `generativeUIRegistry` otherwise (lightweight windows). Prompt catalogs and schema
 * checks keep reading the registry, so a component contributed by a community plugin renders but is not offered to
 * the model.
 */
import { createLazyContributionPoint } from '@/ui-sdk/lazy';
import type { GenerativeComponentConfig } from './types';

export type { GenuiComponentContribution } from '@/ui-kernel/contracts/genui';

export const genuiComponentContributions = createLazyContributionPoint<GenerativeComponentConfig>('genui.components');
