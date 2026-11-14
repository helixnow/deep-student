import type { UiPlugin } from '@/ui-sdk';

/**
 * Every official UI plugin (`./<dir>/index.ts`). Production builds replace this module with `virtual:ds-official-plugins`
 * (`src/platform/official-plugins.ts`, registered in vite.config.ts), which lists only the plugins for
 * `VITE_DS_PLATFORM` and leaves `devOnly` plugins out; tests and the dev server load every directory and the kernel
 * skips what does not apply.
 */
const modules = import.meta.glob<{ default: UiPlugin }>('./*/index.ts', { eager: true });

export const officialUiPlugins: readonly UiPlugin[] = Object.values(modules).map((module) => module.default);

/**
 * Meta-only stubs of the official plugins a build leaves out, installed first so the kernel records them as skipped.
 * Empty here, where every plugin is loaded; the virtual module fills it in.
 */
export const excludedOfficialUiPlugins: readonly UiPlugin[] = [];
