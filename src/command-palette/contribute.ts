/**
 * Command contributions from UI plugins (FE-B1).
 *
 * A feature's UI plugin calls `contributeCommands(ctx, create)` in `apply`; each command goes through
 * `ctx.ui.commands.register`, so it is owned by that plugin and revoked when the plugin unloads.
 *
 * Some modules evaluate `i18next.t()` while building their commands. The registered objects are stable and read every
 * field from the latest `create()` result, which is rebuilt after a language change and once the active language's
 * `command_palette` namespace arrives. Registration order — which decides search and shortcut ties — therefore never
 * changes after installation.
 */
import i18next from 'i18next';
import type { Context } from '@deepseek-ai/cordis';
import type { Command } from './registry/types';

const COMMAND_FIELDS = [
  'name', 'description', 'category', 'shortcut', 'icon', 'execute', 'isEnabled', 'visibleInViews', 'workbenchApps',
  'keywords', 'priority', 'tags', 'dangerous', 'requireConfirm', 'confirmMessage',
] as const satisfies readonly (keyof Command)[];

function liveCommand(id: string, current: () => Command): Command {
  const command = { id } as Command;
  for (const field of COMMAND_FIELDS) {
    if (!(field in current())) continue;
    Object.defineProperty(command, field, { enumerable: true, get: () => current()[field] });
  }
  return command;
}

export function contributeCommands(ctx: Context, create: () => readonly Command[]): void {
  let latest = new Map(create().map((command) => [command.id, command]));
  const ids = [...latest.keys()];
  for (const id of ids) ctx.ui.commands.register(liveCommand(id, () => latest.get(id)!) as Command & Record<string, unknown>);

  const rebuild = () => {
    const next = new Map(create().map((command) => [command.id, command]));
    if (next.size !== ids.length || ids.some((id) => !next.has(id))) {
      console.error('[CommandPalette] a command module changed its command ids after installation; keeping the installed set', ids, [...next.keys()]);
      return;
    }
    latest = next;
  };
  const onAdded = (lng: string, ns: string) => {
    if (ns === 'command_palette' && lng === i18next.language) rebuild();
  };
  ctx.effect(() => {
    i18next.on('languageChanged', rebuild);
    i18next.store?.on('added', onAdded);
    return () => {
      i18next.off('languageChanged', rebuild);
      i18next.store?.off('added', onAdded);
    };
  }, 'command-palette.i18n');
}
