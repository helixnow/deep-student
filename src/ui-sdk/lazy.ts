/**
 * Lazy chunk contribution points for official plugin code (`ctx.ui.attach`). A separate entry so the contract modules
 * that startup code imports stay dependency-free; not part of the `@deepstudent/ui` import map.
 */
export { createLazyContributionPoint, type LazyContributionPoint } from '../ui-kernel/lazy';
