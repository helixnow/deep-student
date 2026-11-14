import type { GenerativeComponentConfig } from '@/features/generative-ui/types';

/** `genui.components` (keyed, key = block type): generative UI block components (FE-B6). */
export type GenuiComponentContribution = GenerativeComponentConfig;

declare module '../slot-map' {
  interface SlotMap {
    'genui.components': GenuiComponentContribution;
  }
}
