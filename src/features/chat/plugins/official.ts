/**
 * The official chat UI plugin: contributes the built-in chat blocks, event handlers, modes and tool result
 * views through the kernel (`ctx.ui.chat.*`, `chat.toolResults`).
 *
 * The built-in modules still register into the chat registries when imported, so messages render before the
 * kernel exists and in windows without one. Installing this plugin adopts those entries under its id: the kernel
 * then owns and lists them, conflicting community registrations are rejected, and unloading drops the kernel
 * layer while the module layer keeps chat rendering.
 *
 * When the full official UI plugin suite is installed (`installOfficialUiPlugins`), `src/ui-plugins/official/chat`
 * already owns `dstu.ui.chat` (for FE-B1 chat commands) and attaches `chatFeatureContributions`, so announcing
 * here adds the FE-B2/B3 chat contributions onto that same plugin fiber without overwriting its commands.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, type UiKernel } from '@/ui-kernel/kernel';
import { whenAppUiKernel } from '@/ui-kernel/app-kernel';
import { chatFeatureContributions } from '@/ui-plugins/official/chat';
import { blockRegistry, eventRegistry, modeRegistry, MODULE_OWNER, type Registry } from '../registry';
import { officialToolResultEntries } from './blocks/toolResults';

export const OFFICIAL_CHAT_UI_PLUGIN_ID = 'dstu.ui.chat';

function adoptModuleEntries<T>(ctx: Context, registry: Registry<T>, register: (key: string, value: T) => void): void {
  const adopted = new Map<string, T>();
  const sync = () => {
    for (const entry of registry.entries()) {
      if (entry.owner !== MODULE_OWNER || adopted.get(entry.key) === entry.value) continue;
      adopted.set(entry.key, entry.value);
      register(entry.key, entry.value);
    }
  };
  sync();
  ctx.effect(() => registry.subscribe(sync), `chat.adopt(${registry.getName()})`);
}

function applyChatFeatureContributions(ctx: Context): void {
  adoptModuleEntries(ctx, blockRegistry, (type, plugin) => ctx.ui.chat.registerBlock(type, plugin));
  adoptModuleEntries(ctx, eventRegistry, (type, handler) => ctx.ui.chat.registerEvent(type, handler));
  adoptModuleEntries(ctx, modeRegistry, (name, mode) => ctx.ui.chat.registerMode(name, mode));
  for (const entry of officialToolResultEntries) ctx.ui.contribute('chat.toolResults', entry);
}

chatFeatureContributions.announce(applyChatFeatureContributions);

export const officialChatUiPlugin = defineUiPlugin({
  meta: { id: OFFICIAL_CHAT_UI_PLUGIN_ID },
  apply(ctx) {
    applyChatFeatureContributions(ctx);
  },
});

/**
 * Installs the official chat UI plugin into `kernel` through the shared official installer (builtin origin).
 * If `installOfficialUiPlugins` already installed `dstu.ui.chat`, its `chatFeatureContributions` attachment
 * already mounted the chat blocks/events/modes/toolResults without overwriting `dstu.ui.chat`'s commands.
 */
export async function installOfficialChatUiPlugin(kernel: UiKernel): Promise<boolean> {
  if (kernel.list().includes(OFFICIAL_CHAT_UI_PLUGIN_ID)) return true;
  const { installOfficialUiPlugin } = await import('@/ui-plugins/official/install');
  return installOfficialUiPlugin(kernel, officialChatUiPlugin);
}

let scheduled = false;

/** Installs into the main window's kernel once it exists (no-op in windows and tests without one). */
export function installOfficialChatUiPluginWhenReady(): void {
  if (scheduled) return;
  scheduled = true;
  whenAppUiKernel((kernel) => {
    installOfficialChatUiPlugin(kernel).catch((error) => console.error('[chat] failed to install the official chat UI plugin', error));
  });
}
