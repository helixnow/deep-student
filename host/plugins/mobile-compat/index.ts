/**
 * `dstu.mobile.compat`：移动端「已注册但不支持」的命令占位插件。
 *
 * 移动端 Host 只装配运行时闭包不含 Node 依赖的插件（`scripts/portability/scan.mjs --profile
 * host/profiles/mobile.json`）。桌面独占插件的命令在移动端没有任何注册者，kernel 对未注册命令的回复在
 * release 构建里是 `Command <name> not allowed by ACL`（`host/kernel/errors.ts`），前端只能显示成
 * ACL 错误——用户看到的是「权限故障」而不是「这个功能移动端还没有」。
 *
 * 本插件为这些命令注册明确的降级实现：一律 reject
 * `UNSUPPORTED_ON_PLATFORM: <capability> is not available on mobile`
 * （`host/platform/errors/unsupported-commands.ts`）。前端按 `UNSUPPORTED_ON_PLATFORM_PREFIX`
 * 识别，能力清单见 `mobile/src/capabilities.ts`。
 *
 * 命令表由 `node scripts/mobile-compat/generate.mjs` 生成：Rust `allow-application-commands` 与
 * `contracts/ipc` 的交集，减去其它移动端插件 `meta.commands` 已声明的命令。新增移动端插件或在移动端
 * 实现某个命令后重跑生成器即可（`tests/commands.test.ts` 守护漂移）。
 */
import { definePlugin } from '../../kernel/api.ts';
import { registerUnsupportedCommands } from '../../platform/errors/unsupported-commands.ts';
import { COMPAT_COMMANDS } from './commands.ts';

export default definePlugin({
  meta: {
    id: 'dstu.mobile.compat',
    lane: 'W14-portable',
    platforms: ['mobile'],
    commands: [...COMPAT_COMMANDS],
  },
  apply(ctx) {
    registerUnsupportedCommands(ctx, COMPAT_COMMANDS);
  },
});
