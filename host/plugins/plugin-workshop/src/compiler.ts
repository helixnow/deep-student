// RUST-FIX(RF-P3-workshop-compiler): built-in compilation and real lifecycle self-check.
import { mkdir, readFile, writeFile, readdir, lstat, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { checkManifest, checkPluginModule, type PluginManifest } from '../../../kernel/manifest.ts';
import { HostRuntime } from '../../../kernel/runtime.ts';
import { ContractSet } from '../../../kernel/contract-set.ts';
import type { AppInfo, HostPlugin } from '../../../kernel/api.ts';
import type { WorkshopCheck } from '../api.ts';
import type { Plugin } from 'esbuild';
import type { WorkshopSelfCheckContext } from '../../../kernel/plugin-admin.ts';

export const uiExternals = ['react', 'react-dom', '@deepstudent/ui', 'i18next'] as const;
/** Resolve only source files. No npm resolution, tsconfig discovery or filesystem-backed externals. */
async function sourceBoundary(source: string, ui: boolean): Promise<Plugin> {
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
export interface WorkshopBuild { check: WorkshopCheck; directory: string; sourceDirectory: string; manifest: PluginManifest | null; }
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
    if (!manifest.host) throw new Error('WORKSHOP_INVALID: Host entry required');
    check.manifest = 'passed';
    await mkdir(join(directory, 'dist'), { recursive: true });
    await build({ entryPoints: [managedRelative(source, manifest.host)], outfile: join(directory, 'dist/host.js'),
      bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external', logLevel: 'silent',
      tsconfigRaw: {}, plugins: [await sourceBoundary(source, false)] });
    if (manifest.ui) await build({ entryPoints: [managedRelative(source, manifest.ui)], outfile: join(directory, 'dist/ui.js'),
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: [...uiExternals],
      jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', logLevel: 'silent',
      tsconfigRaw: {}, plugins: [await sourceBoundary(source, true)] });
    pkg.deepStudent.host = './dist/host.js';
    if (manifest.ui) pkg.deepStudent.ui = './dist/ui.js';
    // Only generated ESM and the screened manifest are installable/exportable.
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
function selfCheckServices(services: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakMap<object, object>();
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
  return Object.fromEntries(Object.entries(services).map(([name, service]) => [name, isolate(service)]));
}

/** Real kernel lifecycle with read-only service facades. Not a code sandbox. */
export async function checkWorkshopLifecycle(result: WorkshopBuild, app: AppInfo,
  context?: (names: readonly string[]) => Promise<WorkshopSelfCheckContext>): Promise<WorkshopCheck> {
  const { check, manifest, directory } = result;
  check.ok = false;
  if (check.compile !== 'passed' || !manifest?.host) return check;
  // Check authoritative safe mode before require(), including module top-level effects.
  const initial = await context?.([]);
  if (initial?.safeMode) throw new Error('SAFE_MODE_ACTIVE: workshop lifecycle is disabled');
  const runtime = new HostRuntime({ app, contracts: new ContractSet([]) });
  try {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const screened = checkManifest(pkg, { appVersion: app.version, context: 'community-install', platform: 'desktop', expectedId: manifest.id });
    if (!screened.ok) throw screened.error;
    if (screened.manifest.version !== manifest.version || JSON.stringify(screened.manifest.permissions) !== JSON.stringify(manifest.permissions)) {
      throw new Error('WORKSHOP_INVALID: candidate subject changed after confirmation');
    }
    // Node 24 require(ESM) loads the actual built file, not Vite's development module graph.
    const plugin = createRequire(import.meta.url)(managedRelative(directory, manifest.host)).default as HostPlugin;
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
    await runtime.unload(manifest.id);
    check.lifecycle = 'passed';
    check.ok = true;
  } catch (error) {
    check.lifecycle = 'failed';
    check.errors.push(error instanceof Error ? error.message : String(error));
  } finally { await runtime.dispose(); }
  return check;
}
