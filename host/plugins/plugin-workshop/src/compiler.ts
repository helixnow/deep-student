// RUST-FIX(RF-P3-workshop-compiler): built-in compilation and real lifecycle self-check.
import { mkdir, readFile, writeFile, readdir, lstat, realpath, stat, copyFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { checkManifest, checkPluginModule, type PluginManifest } from '../../../kernel/manifest.ts';
import { declaredCapabilities, detectPlaces } from './declared.ts';
import { detectUse, SHARED_UI_MODULES } from './detect.ts';
import { HostRuntime } from '../../../kernel/runtime.ts';
import { mountDeclarativeAssets } from '../../../kernel/declarative-loader.ts';
import { ContractSet } from '../../../kernel/contract-set.ts';
import type { AppInfo, HostPlugin } from '../../../kernel/api.ts';
import type { WorkshopCheck, WorkshopPlace } from '../api.ts';
import type { Plugin } from 'esbuild';
import type { WorkshopSelfCheckContext } from '../../../kernel/plugin-admin.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import type {} from '../../../kernel/plugin-agent-tools.ts';

/** The app's shared UI modules (import map); kept as imports in dist/ui.js. */
export const uiExternals = SHARED_UI_MODULES;
/** Resolve only source files. No npm resolution, tsconfig discovery or filesystem-backed externals. */
async function sourceBoundary(source: string, ui: boolean, sealed = false): Promise<Plugin> {
  const root = await realpath(source);
  const contained = (file: string) => {
    const rel = relative(root, file);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw new Error(`WORKSHOP_INVALID: compiler input outside source: ${file}`);
    }
  };
  return { name: 'managed-source-inputs', setup(api) {
    api.onResolve({ filter: /.*/ }, async args => {
      const bare = !args.path.startsWith('.') && !isAbsolute(args.path);
      if (args.kind !== 'entry-point' && bare) {
        if (sealed) throw new Error(`WORKSHOP_INVALID: a plugin that declares agentTools cannot import modules ("${args.path}"); network access is tool.fetch (net:<host> permission), the model is ctx.pluginModel (service:pluginModel)`);
        if (!ui || (uiExternals as readonly string[]).includes(args.path)) return { path: args.path, external: true };
        throw new Error(`Unsupported shared UI module: ${args.path}`);
      }
      let requested = resolve(args.resolveDir || root, args.path);
      const logical = relative(resolve(source), requested);
      if (logical !== '..' && !logical.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(logical)) requested = resolve(root, logical);
      contained(requested);
      for (const file of [requested, ...['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts', '.json', '.css'].map(ext => requested + ext),
        ...['index.tsx', 'index.ts', 'index.jsx', 'index.js', 'index.json'].map(name => join(requested, name))]) {
        let actual: string;
        try { actual = await realpath(file); }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
        contained(actual);
        if ((await stat(actual)).isFile()) return { path: actual };
      }
      throw new Error(`WORKSHOP_INVALID: unresolved source input ${args.path}`);
    });
    api.onLoad({ filter: /.*/, namespace: 'file' }, async args => { contained(await realpath(args.path)); return undefined; });
  } };
}
async function compilerEngine(): Promise<typeof import('esbuild')> {
  const require = createRequire(import.meta.url);
  const platformPackage = require.resolve(`@esbuild/${process.platform}-${process.arch}/package.json`);
  if (/app\.asar[/\\]/.test(platformPackage)) {
    // child_process cannot execute inside asar, even when Electron fs can read that path.
    const unpacked = dirname(platformPackage.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'));
    process.env.ESBUILD_BINARY_PATH = process.platform === 'win32' ? join(unpacked, 'esbuild.exe') : join(unpacked, 'bin/esbuild');
  }
  return import('esbuild');
}
export function managedRelative(root: string, name: string): string {
  const file = resolve(root, name);
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`WORKSHOP_INVALID: path outside source: ${name}`);
  return file;
}
/** Reject links in supported generated trees; no reads escape the Host-assigned root. */
export async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error('WORKSHOP_INVALID: source links are not supported');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) files.push(relative(root, file));
    }
  }
  await walk(root);
  return files;
}
export interface WorkshopBuild {
  check: WorkshopCheck; directory: string; sourceDirectory: string; manifest: PluginManifest | null;
  /** Host-derived, plain-language capability lines of this candidate (set by the lifecycle check). */
  declared?: string[];
  /** Where the user finds it once installed (set by the lifecycle check). */
  places?: WorkshopPlace[];
}

/**
 * Free globals a Host half that declares agentTools may not reference. Such a plugin runs when the model decides,
 * so everything it reaches must be something the user saw at confirmation: its declared services, and
 * `tool.fetch` for its declared hosts. esbuild `define` rewrites only unbound references (not properties, strings
 * or shadowing locals), which is exactly the set to refuse. This is a misuse guard for generated code, not a
 * sandbox: installed plugins still run in the application process (docs/plugins/SECURITY.md).
 */
export const sealedHostGlobals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'process', 'require', 'module',
  'globalThis', 'global', 'eval', 'Function', 'WebAssembly', 'Worker', 'Deno', 'Bun'] as const;
const SEALED_MARK = '__dstu_sealed_global_';
function sealedGlobalProblems(code: string): string[] {
  const used = new Set<string>();
  for (const match of code.matchAll(new RegExp(`${SEALED_MARK}([A-Za-z]+)`, 'g'))) used.add(match[1]!);
  const problems = [...used].map(name => `WORKSHOP_INVALID: a plugin that declares agentTools cannot use the global "${name}"; use tool.fetch for declared hosts and injected services for everything else`);
  if (/\bimport\s*\(/.test(code) || code.includes('import.meta')) {
    problems.push('WORKSHOP_INVALID: a plugin that declares agentTools cannot use dynamic import() or import.meta');
  }
  return problems;
}

export { declaredCapabilities } from './declared.ts';
export interface WorkshopManifestDefaults {
  displayName?: string;
  description?: string;
}

export async function compileWorkshop(
  source: string,
  builds: string,
  expectedId: string,
  app: AppInfo,
  defaults?: WorkshopManifestDefaults,
): Promise<WorkshopBuild> {
  const check: WorkshopCheck = { ok: false, manifest: 'failed', compile: 'failed', lifecycle: 'not-run', visual: 'not-verified', errors: [] };
  // Unique immutable candidate: a failed edit never overwrites the last validated build.
  const directory = join(builds, randomUUID());
  let manifest: PluginManifest | null = null;
  try {
    if ((await lstat(source)).isSymbolicLink()) throw new Error('WORKSHOP_INVALID: source root must not be a symbolic link');
    const { build } = await compilerEngine();
    const files = await sourceFiles(source);
    // The built-in compiler owns its configuration; never discover/extend model-supplied tsconfig files.
    if (files.some(file => /^tsconfig(?:\..*)?\.json$/.test(file))) throw new Error('WORKSHOP_INVALID: custom tsconfig files are not supported by the built-in compiler');
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (pkg && typeof pkg === 'object' && !Array.isArray(pkg) && pkg.deepStudent && typeof pkg.deepStudent === 'object' && !Array.isArray(pkg.deepStudent)) {
      if ((typeof pkg.deepStudent.displayName !== 'string' || !pkg.deepStudent.displayName.trim()) && defaults?.displayName?.trim()) {
        pkg.deepStudent.displayName = defaults.displayName.trim();
      }
      if (pkg.deepStudent.description === undefined && defaults?.description?.trim()) {
        pkg.deepStudent.description = defaults.description.trim();
      }
    }
    const screened = checkManifest(pkg, { appVersion: app.version, context: 'community-install', platform: 'desktop', expectedId });
    if (!screened.ok) throw screened.error;
    manifest = screened.manifest;
    if (!manifest.host && !manifest.ui && !manifest.declarative) {
      throw new Error('WORKSHOP_INVALID: plugin must declare a host, ui, or declarative entry');
    }
    check.manifest = 'passed';
    if (manifest.host || manifest.ui) {
      await mkdir(join(directory, 'dist'), { recursive: true });
    } else {
      await mkdir(directory, { recursive: true });
    }
    const sealed = (manifest.agentTools?.length ?? 0) > 0;
    if (manifest.host) {
      await build({ entryPoints: [managedRelative(source, manifest.host)], outfile: join(directory, 'dist/host.js'),
        bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external', logLevel: 'silent',
        ...(sealed ? { define: Object.fromEntries(sealedHostGlobals.map(name => [name, `${SEALED_MARK}${name}`])) } : {}),
        tsconfigRaw: {}, plugins: [await sourceBoundary(source, false, sealed)] });
      if (sealed) {
        const problems = sealedGlobalProblems(await readFile(join(directory, 'dist/host.js'), 'utf8'));
        if (problems.length) throw new Error(problems.join('\n'));
      }
      pkg.deepStudent.host = './dist/host.js';
    }
    if (manifest.ui) {
      await build({ entryPoints: [managedRelative(source, manifest.ui)], outfile: join(directory, 'dist/ui.js'),
        bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: [...uiExternals],
        jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', logLevel: 'silent',
        tsconfigRaw: {}, plugins: [await sourceBoundary(source, true)] });
      pkg.deepStudent.ui = './dist/ui.js';
    }
    if (manifest.declarative) {
      const declPaths = [
        ...(manifest.declarative.rubrics ?? []),
        ...(manifest.declarative.skills ?? []),
        ...(manifest.declarative.cardTemplates ?? []),
        ...(manifest.declarative.workflows ?? []),
      ];
      for (const relPath of declPaths) {
        const srcFile = managedRelative(source, relPath);
        const destFile = managedRelative(directory, relPath);
        await mkdir(dirname(destFile), { recursive: true });
        await copyFile(srcFile, destFile);
      }
    }
    // Only generated ESM, declared assets, and the screened manifest are installable/exportable.
    delete pkg.scripts;
    await writeFile(join(directory, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    check.compile = 'passed';
    const built = checkManifest(pkg, { appVersion: app.version, context: 'community-install', platform: 'desktop', expectedId });
    if (!built.ok) throw built.error;
    manifest = built.manifest;
  } catch (error) { check.errors.push(error instanceof Error ? error.message : String(error)); }
  return { check, directory, sourceDirectory: source, manifest };
}
/** Detached, read-only service facades: validation never calls live service methods. */
/**
 * Registration calls a plugin makes in apply that only record intent (a scheduled job): during validation they get a
 * no-op disposer, so a plugin that schedules itself passes the self-check without anything being scheduled.
 */
const SELF_CHECK_REGISTRATIONS: Readonly<Record<string, readonly string[]>> = {
  pluginSchedule: ['register', 'daily', 'weekly', 'every', 'onStartup'],
  chatPipelineHooks: ['register'],
  gradingRubrics: ['register'],
  reviewSchedulers: ['register'],
};
function selfCheckServices(services: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakMap<object, object>();
  const registered = (): (() => void) => () => {};
  const denied = (): never => { throw new Error('WORKSHOP_SELF_CHECK_READ_ONLY: live service operations are disabled during validation'); };
  const isolate = (value: unknown): unknown => {
    if (typeof value === 'function') return denied;
    if (value === null || typeof value !== 'object') return value;
    const existing = seen.get(value);
    if (existing) return existing;
    // The proxy target is detached so prototype/descriptor access cannot expose
    // the original service. Never invoke live methods or accessors.
    const facade: object = new Proxy({}, {
      get: (_, key) => {
        for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, key);
          if (descriptor) return 'value' in descriptor ? isolate(descriptor.value) : denied();
        }
        return undefined;
      },
      set: denied,
      defineProperty: denied,
      deleteProperty: denied,
      setPrototypeOf: denied,
    });
    seen.set(value, facade);
    return facade;
  };
  return Object.fromEntries(Object.entries(services).map(([name, service]) => {
    const registrations = SELF_CHECK_REGISTRATIONS[name];
    if (!registrations || service === null || typeof service !== 'object') return [name, isolate(service)];
    const facade = isolate(service) as object;
    return [name, new Proxy(facade, { get: (target, key) => typeof key === 'string' && registrations.includes(key)
      && typeof (service as Record<string, unknown>)[key] === 'function' ? registered : Reflect.get(target, key) })];
  }));
}

/** Real kernel lifecycle with read-only service facades. Not a code sandbox. */
export async function checkWorkshopLifecycle(result: WorkshopBuild, app: AppInfo,
  context?: (names: readonly string[]) => Promise<WorkshopSelfCheckContext>): Promise<WorkshopCheck> {
  const { check, manifest, directory } = result;
  check.ok = false;
  if (check.compile !== 'passed' || !manifest || (!manifest.host && !manifest.ui && !manifest.declarative)) return check;
  // Check authoritative safe mode before require(), including module top-level effects.
  const initial = await context?.([]);
  if (initial?.safeMode) throw new Error('SAFE_MODE_ACTIVE: workshop lifecycle is disabled');
  const runtime = new HostRuntime({ app, contracts: new ContractSet([]) });
  runtime.setDeclarativeLoader(mountDeclarativeAssets);
  try {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const screened = checkManifest(pkg, { appVersion: app.version, context: 'community-install', platform: 'desktop', expectedId: manifest.id });
    if (!screened.ok) throw screened.error;
    if (screened.manifest.version !== manifest.version || JSON.stringify(screened.manifest.permissions) !== JSON.stringify(manifest.permissions)
      || JSON.stringify(screened.manifest.agentTools ?? []) !== JSON.stringify(manifest.agentTools ?? [])) {
      throw new Error('WORKSHOP_INVALID: candidate subject changed after confirmation');
    }
    const plugin: HostPlugin = manifest.host
      // Node 24 require(ESM) loads the actual built file, not Vite's development module graph.
      ? createRequire(import.meta.url)(managedRelative(directory, manifest.host)).default as HostPlugin
      : {
          meta: {
            id: manifest.id,
            version: manifest.version,
            platforms: [...manifest.platforms],
          },
          apply() {},
        };
    const names = [...(plugin.inject ?? [])];
    const environment = context ? await context(names) : { trust: 'restricted' as const, safeMode: false, services: {} };
    if (environment.safeMode) throw new Error('SAFE_MODE_ACTIVE: workshop lifecycle is disabled');
    const effectiveManifest = { ...manifest, trust: environment.trust };
    const problem = checkPluginModule(effectiveManifest, plugin);
    if (problem) throw problem;
    const missing = names.filter(name => environment.services[name] === undefined);
    if (missing.length) {
      check.lifecycle = 'not-run';
      check.errors.push(`WORKSHOP_SELF_CHECK_UNAVAILABLE: application services unavailable: ${missing.join(', ')}`);
      return check;
    }
    const services = selfCheckServices(environment.services);
    for (const name of names) runtime.ctx.provide(name, services[name]);
    await runtime.installEntry({ plugin, packageRoot: directory, manifest: effectiveManifest });
    // Every declared agent tool needs its handler on the primary service; the handlers themselves are not called.
    const declaredTools = manifest.agentTools ?? [];
    if (declaredTools.length) {
      const offered = new Set((runtime.ctx.get('pluginAgentTools')?.list() ?? []).map(tool => tool.name));
      const missingTools = declaredTools.filter(tool => !offered.has(tool.name)).map(tool => tool.name);
      if (missingTools.length) {
        throw new Error(`WORKSHOP_INVALID: agentTools ${missingTools.map(name => `"${name}"`).join(', ')} need a method of the same name on the primary service "${pluginServiceName(manifest.id)}" (listed in meta.provides)`);
      }
    }
    await runtime.unload(manifest.id);
    let uiBundle: string | undefined;
    if (manifest.ui) { try { uiBundle = await readFile(managedRelative(directory, manifest.ui), 'utf8'); } catch { uiBundle = undefined; } }
    // The card's lines: the manifest and inject list, plus what the built code itself uses (information only).
    const hostBundle = manifest.host ? await readFile(managedRelative(directory, manifest.host), 'utf8') : undefined;
    result.declared = declaredCapabilities(manifest, names, detectUse({ host: hostBundle, ui: uiBundle }, names));
    result.places = detectPlaces(manifest, uiBundle);
    check.lifecycle = 'passed';
    check.ok = true;
  } catch (error) {
    check.lifecycle = 'failed';
    check.errors.push(error instanceof Error ? error.message : String(error));
  } finally { await runtime.dispose(); }
  return check;
}
