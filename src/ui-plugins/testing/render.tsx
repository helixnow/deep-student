/** Shared consumer-test assembly: a real kernel and the production official installer. */
import type { ReactNode } from 'react';
import { cleanup, render, type RenderOptions } from '@testing-library/react';
import { afterAll, beforeAll } from 'vitest';
import { UiKernel, type UiAdapters } from '../../ui-kernel/kernel';
import { UiKernelProvider } from '../../ui-kernel/react';
import { installOfficialUiPlugins } from '../official/install';
import { memoryRegistryAdapters } from './registries';

export async function createOfficialUiTestKernel(adapters: UiAdapters = {}): Promise<UiKernel> {
  const kernel = new UiKernel({ ...memoryRegistryAdapters(), ...adapters });
  await installOfficialUiPlugins(kernel);
  return kernel;
}

/**
 * Testing Library's `render`, wrapped in a `<UiKernelProvider>` whose kernel has the production official plugins.
 * Call once at the top level of a test file: one kernel is installed in `beforeAll` and disposed in `afterAll`.
 * Production renders official consumers (ModernSidebar, MobileSidebarNavigation, …) only inside `main.tsx`'s Provider.
 */
export function officialUiRender(adapters: UiAdapters = {}): typeof render {
  let kernel: UiKernel | undefined;
  beforeAll(async () => { kernel = await createOfficialUiTestKernel(adapters); });
  afterAll(async () => {
    cleanup();
    await kernel?.dispose();
  });
  return ((ui: ReactNode, options?: RenderOptions) => {
    if (!kernel) throw new Error('officialUiRender: render called before beforeAll installed the official kernel');
    const installed = kernel;
    const Inner = options?.wrapper;
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <UiKernelProvider kernel={installed}>{Inner ? <Inner>{children}</Inner> : children}</UiKernelProvider>
    );
    return render(ui as Parameters<typeof render>[0], { ...options, wrapper: Wrapper });
  }) as typeof render;
}

export async function renderWithOfficialUi(children: ReactNode, options?: Omit<RenderOptions, 'wrapper'>) {
  const kernel = await createOfficialUiTestKernel();
  const Wrapper = ({ children }: { children: ReactNode }) => <UiKernelProvider kernel={kernel}>{children}</UiKernelProvider>;
  const result = render(children, { ...options, wrapper: Wrapper });
  return {
    ...result,
    kernel,
    async dispose() {
      result.unmount();
      await kernel.dispose();
    },
  };
}
