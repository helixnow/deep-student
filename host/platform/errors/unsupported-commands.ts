/**
 * 移动端「命令已注册但当前平台没有这项能力」的占位实现。
 *
 * 移动端 Host 只装配运行时闭包不含 Node 依赖的插件（`scripts/portability/scan.mjs --profile`），
 * 桌面独占的命令原本在移动端**根本没有注册**；kernel 对未注册命令的回复在 release 构建里是
 * `Command <name> not allowed by ACL`（`host/kernel/errors.ts`），前端只能显示成 ACL 错误，
 * 看起来像权限故障而不是「这个功能移动端还没有」。
 *
 * 因此每个声明了该命令的移动端插件都用这里注册一个明确的
 * `UNSUPPORTED_ON_PLATFORM: <capability> is not available on mobile` 处理函数：
 * 前端按 {@link UNSUPPORTED_ON_PLATFORM_PREFIX} 识别并提示，能力清单见 `mobile/src/capabilities.ts`。
 *
 * 本文件不 import 任何 Node 模块（移动端 Worker 直接打包）。
 */
import { CommandError } from '../../kernel/api.ts';
import { unsupportedOnPlatformMessage } from './unsupported-on-platform.ts';

/** 注册 `ctx.commands` 的最小接口（避免依赖 Cordis 的完整 Context 类型）。 */
export interface UnsupportedCommandTarget {
  commands: { register(name: string, handler: () => never): void };
}

export type CapabilityOf = (command: string) => string;

/**
 * 为一个插件的桌面独占命令注册占位处理函数。
 *
 * @param ctx     插件的 `apply` 上下文（命令归属该插件，`meta.commands` 必须声明这些名字）。
 * @param names   命令名；调用时一律 reject `UNSUPPORTED_ON_PLATFORM`。
 * @param capability 命令 → 能力 id（缺省用 {@link defaultCapabilityOf} 按前缀归类）。
 * @param platform 当前平台名（进错误消息，默认 `mobile`）。
 */
export function registerUnsupportedCommands(
  ctx: UnsupportedCommandTarget,
  names: readonly string[],
  capability: CapabilityOf = defaultCapabilityOf,
  platform = 'mobile',
): void {
  for (const name of names) {
    ctx.commands.register(name, () => {
      throw new CommandError(unsupportedOnPlatformMessage(capability(name), platform));
    });
  }
}

/** 按命令前缀归类到 `mobile/src/capabilities.ts` 的能力 id。 */
export function defaultCapabilityOf(command: string): string {
  if (command.startsWith('media_bilibili_')) return 'media.bilibili';
  if (command.startsWith('media_transcri') || command === 'voice_input_transcribe') return 'media.transcribe';
  if (command.startsWith('media_')) return 'media';
  if (command.startsWith('browser_')) return 'browser.window';
  if (command.startsWith('data_governance_')) return 'data.governance';
  if (command.startsWith('skill_')) return 'agent.skills';
  if (command.startsWith('chat_v2_')) return 'agent.workspace';
  if (command.startsWith('plugin_')) return 'plugin.manager';
  if (command.startsWith('secure_')) return 'secrets';
  if (command.startsWith('cloud_config_')) return 'cloud.config';
  if (command.startsWith('mcp_stdio') || command.includes('_oauth')) return 'mcp.stdio';
  if (command.startsWith('mcp_') || command.startsWith('test_mcp')) return 'mcp';
  if (command.startsWith('pdf_') || command.includes('_pdf_')) return 'media.pdf';
  if (command.startsWith('ocr') || command.startsWith('test_ocr')) return 'media.ocr';
  if (command.startsWith('tts_')) return 'media.tts';
  if (command.includes('debug_log') || command.includes('logs')) return 'log.debug';
  return 'desktop.command';
}
