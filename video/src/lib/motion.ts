import type { SpringCfg } from './time';

/**
 * 产品动效原值。每一项都能在主应用源码里找到出处，改动前先核对源码：
 * - src/styles/motion-springs.ts
 * - src/features/workbench/styles/workbench.tokens.css / motion.css
 * - src/features/chat/components/ui/ToolActivitySweep.css
 * - src/features/mindmap/**、src/features/flashcards/**、src/components/Card3DPreview.tsx
 */
export const springSnap: SpringCfg = { stiffness: 400, damping: 30 };
export const springSheet: SpringCfg = { stiffness: 380, damping: 30 };
export const springSoft: SpringCfg = { stiffness: 300, damping: 26 };
export const userBubbleSpring: SpringCfg = { stiffness: 400, damping: 30, mass: 0.8 };

export const DUR = {
  tweenFast: 0.15,
  messageEnter: 0.15,
  windowOpen: 0.22,
  windowClose: 0.11,
  genie: 0.4,
  mindmapNodeEnter: 0.18,
  mindmapLayout: 0.2,
  reciteReveal: 0.3,
  ankiCascade: 0.24,
  ankiStagger: 0.035,
  cardFlip: 0.3,
  cardEnter: 0.26,
  swipeSettle: 0.2,
  haloIgnite: 0.34,
  haloBreathe: 2.2,
  toolSweep: 1.6,
  thinkingShimmer: 1.5,
  progressRing: 0.6,
  scoreRing: 0.7,
} as const;

export const SWEEP = { angleDeg: 105, whiteAlpha: 0.42 } as const;

export const CARD3D = { perspective: 1200, zStep: -80, rotateY: -5 } as const;

export const SWIPE = { deadZone: 12, threshold: 80, tiltPerPx: 0.04, flyOutPct: 1.3, flyOutRotate: 12 } as const;

export const WINDOW_OPEN_FROM_SCALE = 0.34;
