/**
 * W09 门禁：内核契约与运行时/前端门禁的一致性。不重复 kernel 自带测试，只锁住“两边说法必须一致”的部分：
 *
 * 1. `plugin:host|call` 的 `caller` 必填性跟随 `runtime.ts` 的 `DEFAULT_HOST_CALL_CALLER_MODE`
 *    （`warn` → 可选，`require` → 必填，SEC-E06）；契约与 runtime 不一致即红。
 * 2. 契约一旦要求 `caller`，前端 invoke 门禁必须拦住不带 `caller` 的生产调用（同一份 `judge`/`scanFile`）。
 * 3. K7：装载期对 `KERNEL_ONLY_SERVICES` 的注入拒绝逐个覆盖（含 `protocols`，kernel 自带测试只挑了部分）。
 * 4. K7：安装期对 `service:<内核专有服务>` 声明的拒绝逐个覆盖。缺口按
 *    `kernel-contracts-baseline.json` 计数（当前归 W01 的 `assertInstallable`）；新增未登记的缺口即红，
 *    已实现的条目在测试输出里提示从基线移除。
 * 5. `host/kernel/API.md` §16.4 与 `docs/plugins/SECURITY.md` 列出的 kernel 专有服务与 `KERNEL_ONLY_SERVICES` 一致。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KERNEL_ONLY_SERVICES } from '../../../host/kernel/kernel.ts';
import { DEFAULT_HOST_CALL_CALLER_MODE } from '../../../host/kernel/runtime.ts';
import { assertInstallable, checkPluginModule, PluginLoadError, type PluginManifest } from '../../../host/kernel/manifest.ts';
import { definePlugin } from '../../../host/kernel/api.ts';
import { judge, loadCommandContracts, scanFile } from './frontend-invoke.mjs';

const file = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const json = <T>(rel: string): T => JSON.parse(file(rel)) as T;

const hostNative = () => json<{ commands: { name: string; args: { key: string; optional: boolean }[] }[] }>('scripts/electron-migration/contracts/host-native.json');
const hostCall = () => loadCommandContracts().get('plugin:host|call')!;

/** 前端门禁判定：生产代码里以字面量命令名 invoke 时的 findings。 */
const findings = (source: string) => judge(scanFile('src/ui-kernel/__gate_probe.ts', source), loadCommandContracts());

describe('W09 kernel contracts: plugin:host|call caller', () => {
  it('the contract requires caller exactly when the runtime default does', () => {
    const declared = hostCall().args.find((a) => a.key === 'caller');
    expect(declared).toBeDefined();
    expect(declared!.optional).toBe(DEFAULT_HOST_CALL_CALLER_MODE === 'warn');
    // 契约 JSON 由 host-native.json 生成；两者必须同时改，生成物过期由 contracts:check 拦。
    const source = hostNative().commands.find((c) => c.name === 'plugin:host|call');
    expect(source).toBeDefined();
    expect(source!.args.find((a) => a.key === 'caller')!.optional).toBe(declared!.optional);
  });

  it('a production call without caller is rejected by the frontend invoke gate when the runtime requires it', () => {
    const withCaller = 'import { invoke } from "@tauri-apps/api/core";\ninvoke("plugin:host|call", { caller: "alice.ui", service: "wordOfDay", method: "today", args: [] });';
    const withoutCaller = 'import { invoke } from "@tauri-apps/api/core";\ninvoke("plugin:host|call", { service: "wordOfDay", method: "today", args: [] });';
    expect(findings(withCaller)).toEqual([]);
    const missing = findings(withoutCaller).map((f) => [f.rule, f.command, f.key]);
    if (DEFAULT_HOST_CALL_CALLER_MODE === 'require') expect(missing).toEqual([['missing-required', 'plugin:host|call', 'caller']]);
    else expect(missing).toEqual([]);
  });
});

describe('W09 kernel contracts: K7 kernel-only services', () => {
  const kernelOnly = [...KERNEL_ONLY_SERVICES].sort();
  const baseline = json<{ k7InstallRejection: { service: string; reason: string }[] }>(
    'scripts/electron-migration/gate-checks/kernel-contracts-baseline.json',
  );

  const manifest = (permissions: string[]): PluginManifest => ({
    id: 'alice.probe', packageName: 'deepstudent-plugin-alice-probe', version: '1.0.0', engines: '^0.11',
    platforms: ['desktop'], host: './index.mjs', requires: {}, permissions,
  });
  const module = (inject: string[]) =>
    definePlugin({ meta: { id: 'alice.probe', version: '1.0.0' }, inject, apply() {} });

  it('startup rejects injecting any kernel-only service with KERNEL_API_FORBIDDEN', () => {
    for (const service of kernelOnly) {
      const error = checkPluginModule(manifest([`service:${service}`]), module([service]));
      expect(error, `inject ${service}`).not.toBeNull();
      expect(error!.code, `inject ${service}`).toBe('KERNEL_API_FORBIDDEN');
    }
    // 普通服务不受影响（同一套检查里只拦 KERNEL_ONLY_SERVICES）。
    expect(checkPluginModule(manifest(['service:notes']), module(['notes']))).toBeNull();
  });

  /** 安装期是否拒绝 `service:<名称>`：返回错误码，接受时返回 null。 */
  const installCode = (service: string): string | null => {
    const pkg = {
      name: 'deepstudent-plugin-alice-probe', version: '1.0.0', engines: { deepStudent: '^0.11' },
      deepStudent: { manifestVersion: 1, id: 'alice.probe', platforms: ['desktop'], host: './index.mjs', permissions: [`service:${service}`] },
    };
    try {
      assertInstallable(pkg, { appVersion: '0.11.0', platform: 'desktop', installed: new Map() });
      return null;
    } catch (error) {
      return (error as PluginLoadError).code;
    }
  };

  it('install-time rejection of service:<kernel-only> declarations is tracked against the baseline', () => {
    const pending = new Map(baseline.k7InstallRejection.map((e) => [e.service, e.reason]));
    for (const [service, reason] of pending) {
      expect(kernelOnly, `baseline entry ${service} is not a kernel-only service`).toContain(service);
      expect(reason, `baseline entry ${service} needs a reason`).toMatch(/\S/);
    }
    const codes = new Map(kernelOnly.map((service) => [service, installCode(service)]));
    const accepted = kernelOnly.filter((service) => codes.get(service) === null);
    // 每个未拒绝的服务都必须在基线里登记原因；新增缺口（新 kernel 服务没有安装期检查）即红。
    expect(accepted.filter((service) => !pending.has(service))).toEqual([]);
    // 已实现的条目不会让门禁变红，但提醒从基线移除，保持与 kernel 一致性测试逐条对齐。
    const fixed = [...pending.keys()].filter((service) => !accepted.includes(service));
    if (fixed.length) {
      console.info(`[kernel-contracts] K7 安装期拒绝已覆盖 ${fixed.join(', ')}：从 kernel-contracts-baseline.json 移除对应条目`);
    }
    // 拒绝时必须用启动期同一个错误码，不能换个理由拒绝（那会是另一条规则）。
    expect(kernelOnly.filter((service) => {
      const code = codes.get(service);
      return code !== null && code !== 'KERNEL_API_FORBIDDEN';
    })).toEqual([]);
  });

  it('docs list the same kernel-only services as KERNEL_ONLY_SERVICES', () => {
    const documented = (text: string, pattern: RegExp): string[] => {
      const match = pattern.exec(text);
      if (!match) throw new Error(`pattern ${pattern} not found`);
      const [, list = ''] = match;
      return list
        .split(/[、，]/)
        .map((t) => t.replace(/`/g, '').trim())
        .filter((t) => /^[a-z][A-Za-z0-9]*$/.test(t))
        .sort();
    };
    expect(documented(file('host/kernel/API.md'), /kernel 专有服务（(`commands`[^）]*)）/)).toEqual(kernelOnly);
    expect(documented(file('docs/plugins/SECURITY.md'), /注入 kernel 专有服务（(`commands`[^）]*)）/)).toEqual(kernelOnly);
  });
});
