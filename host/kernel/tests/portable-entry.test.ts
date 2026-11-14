/**
 * 内核可移植入口（W14）：`core.ts` 只含 `definePlugin`、类型、常量与纯函数；`api.ts` 继续导出
 * 原有内容（iLink / QR 已移到 `host/plugins/ilink/api.ts` 与 `platform/util/qr.ts`）。
 * 两者运行时闭包都不得加载 Node 专有模块（`import type` 不计），判定用 `scripts/portability` 扫描器。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../scripts/portability/lib/portability.mjs';
import * as core from '../core.ts';
import * as api from '../api.ts';
import * as shell from '../shell.ts';
import * as ilink from '../../plugins/ilink/api.ts';
import * as profilePlatforms from '../../profiles/platforms.ts';
import type { PluginMeta, PluginPlatform } from '../core.ts';
import type { PluginMeta as ApiPluginMeta } from '../api.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('kernel portable entry', () => {
  it('core.ts and api.ts never load Node modules at runtime', () => {
    expect(checkModulesClosure(ROOT, ['host/kernel/core.ts'])).toEqual([]);
    expect(checkModulesClosure(ROOT, ['host/kernel/api.ts'])).toEqual([]);
  });

  it('core.ts exposes only definePlugin, CommandError, errorDisplay and constants as runtime values', () => {
    expect(Object.keys(core).sort()).toEqual([
      'CommandError',
      'GLOBAL_SHORTCUT_TRIGGERED',
      'HOST_CALL_COMMAND',
      'HOST_STATUS_COMMAND',
      'PLUGINS_DEGRADED_EVENT',
      'PLUGIN_MANAGER_CONFIG_COMMAND',
      'PLUGIN_MANAGER_CONFIG_SAVE_COMMAND',
      'PLUGIN_MANAGER_CONSENT_COMMAND',
      'PLUGIN_MANAGER_INSTALL_COMMAND',
      'PLUGIN_MANAGER_LIST_COMMAND',
      'PLUGIN_MANAGER_SET_ENABLED_COMMAND',
      'PLUGIN_MANAGER_SET_TRUST_COMMAND',
      'PLUGIN_MANAGER_UNINSTALL_COMMAND',
      'PLUGIN_MANAGER_UPDATE_IMPACT_COMMAND',
      'PLUGIN_PLATFORMS',
      'UI_MANIFEST_COMMAND',
      'UI_MANIFEST_EVENT',
      'UI_MANIFEST_V2_EVENT',
      'UI_MANIFEST_VERSION',
      'UI_READY_COMMAND',
      'definePlugin',
      'errorDisplay',
    ]);
  });

  it('api.ts re-exports every core value unchanged', () => {
    for (const [name, value] of Object.entries(core)) {
      expect((api as Record<string, unknown>)[name], name).toBe(value);
    }
    const plugin = core.definePlugin({ meta: { id: 'dstu.portable-probe', platforms: ['desktop', 'mobile'] }, apply() {} });
    expect(plugin.name).toBe('dstu.portable-probe');
    expect(plugin.meta.platforms).toEqual(['desktop', 'mobile']);
  });

  it('keeps ShellError as one value across kernel/api.ts and kernel/shell.ts', () => {
    expect(api.ShellError).toBe(shell.ShellError);
    expect(new api.ShellError('op', 'boom', { kind: 'Internal' } as never)).toMatchObject({ name: 'ShellError', op: 'op' });
  });

  it('moves iLink and QR out of the kernel barrel into host/plugins/ilink/api.ts', () => {
    for (const name of ['IlinkClient', 'IlinkBotPlugin', 'qrcodePngBase64', 'encodeQrMatrix', 'chunkText', 'PLUGIN_ID']) {
      expect(name in api, name).toBe(false);
    }
    expect(typeof ilink.IlinkClient).toBe('function');
    expect(typeof ilink.IlinkBotPlugin).toBe('function');
    expect(ilink.PLUGIN_ID).toBe('ilinkbot');
  });

  it('PluginMeta.platforms is part of the kernel plugin types; profiles reuse the same constant', () => {
    const platforms: readonly PluginPlatform[] = ['mobile'];
    const meta: PluginMeta = { id: 'dstu.typed', platforms };
    const viaApi: ApiPluginMeta = meta;
    expect(viaApi.platforms).toEqual(['mobile']);
    expect(profilePlatforms.PLUGIN_PLATFORMS).toBe(core.PLUGIN_PLATFORMS);
    expect(core.PLUGIN_PLATFORMS).toEqual(['desktop', 'mobile']);
    const source = readFileSync(new URL('../../profiles/platforms.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/declare module/);
  });
});
