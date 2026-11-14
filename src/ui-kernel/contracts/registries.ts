/**
 * Value types of the registries behind `ctx.ui.commands`, `ctx.ui.workbench` and `ctx.ui.chat.register*`.
 *
 * The kernel stays free of business modules at runtime; these type-only aliases are the one place where it names the
 * shapes the application registries store, so a contribution with the wrong shape fails to compile.
 */
import type { Command } from '@/command-palette/registry/types';
import type { AppDefinition } from '@/features/workbench/core/types';
import type { BlockRendererPlugin } from '@/features/chat/registry/blockRegistry';
import type { EventHandler } from '@/features/chat/registry/eventRegistry';
import type { ModePlugin } from '@/features/chat/registry/modeRegistry';

/** A command palette entry (`ctx.ui.commands.register`). */
export type UiCommand = Command;
/** A Workbench app definition (`ctx.ui.workbench.registerApp`); the registry key is `typeId`. */
export type UiWorkbenchApp = AppDefinition;
/** A chat block renderer (`ctx.ui.chat.registerBlock(type, …)`). */
export type UiChatBlock = BlockRendererPlugin;
/** A chat event handler (`ctx.ui.chat.registerEvent(type, …)`). */
export type UiChatEventHandler = EventHandler;
/** A chat mode (`ctx.ui.chat.registerMode(name, …)`). */
export type UiChatMode = ModePlugin;
