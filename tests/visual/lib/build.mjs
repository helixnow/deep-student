/**
 * Programmatic Vite builds for the regression net. The repository configs are used unchanged;
 * the only additions are inline plugins:
 *   - pinVersion: `src/version.ts` carries the git hash, which would make every commit look like a
 *     bundle change. Both builds compile a fixed version module instead.
 *   - recordChunks: Rollup's own chunk/module table, captured in generateBundle and written to
 *     `<outDir>/.ds-chunks.json` (chunk-graph reads it for main; boot-check uses it to name the
 *     modules inside the chunks of an import cycle).
 *
 * Builds need an 8 GiB heap (4 GiB OOMs); `runBuildChild` re-executes this module in a child Node
 * with that heap so callers do not have to remember the flag.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const visualRoot = path.join(repoRoot, 'tests/visual');
export const defaultDemoDir = path.join(repoRoot, 'dist-demo');
export const defaultMainDir = path.join(visualRoot, '.out/main-dist');

const PINNED_VERSION = `export const VERSION_INFO = {
  APP_VERSION: '0.0.0-visual',
  BUILD_NUMBER: '20000',
  GIT_HASH: '00000000',
  FULL_VERSION: '0.0.0-visual (20000)',
  SENTRY_RELEASE: '0.0.0-visual+20000.0000000000000000000000000000000000000000',
};
export default VERSION_INFO;
`;

const VERSION_ID = '\0ds-visual-version';

/** `src/version.ts` is generated and untracked; resolve it virtually so it need not exist. */
function pinVersion() {
  const target = path.join(repoRoot, 'src/version');
  return {
    name: 'ds-visual-pin-version',
    enforce: 'pre',
    resolveId(source, importer) {
      const bare = source.split('?')[0].replace(/\.ts$/, '');
      const candidate = bare.startsWith('.') && importer ? path.resolve(path.dirname(importer), bare) : bare;
      return candidate === target ? VERSION_ID : null;
    },
    load(id) {
      return id === VERSION_ID ? PINNED_VERSION : null;
    },
  };
}

function recordChunks(sink) {
  return {
    name: 'ds-visual-record-chunks',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          sink.chunks.push({
            fileName: item.fileName,
            name: item.name,
            isEntry: item.isEntry,
            isDynamicEntry: item.isDynamicEntry,
            facadeModuleId: item.facadeModuleId,
            imports: item.imports,
            dynamicImports: item.dynamicImports,
            importedCss: [...(item.viteMetadata?.importedCss ?? [])],
            bytes: Buffer.byteLength(item.code, 'utf8'),
            modules: Object.fromEntries(Object.entries(item.modules).map(([id, info]) => [id, info.renderedLength])),
          });
        } else {
          sink.assets.push({ fileName: item.fileName, bytes: typeof item.source === 'string' ? Buffer.byteLength(item.source) : item.source.byteLength });
        }
      }
    },
  };
}

export async function buildInProcess(kind, outDir) {
  const { build } = await import('vite');
  const sink = { chunks: [], assets: [] };
  const configFile = path.join(repoRoot, kind === 'demo' ? 'vite.demo.config.ts' : 'vite.config.ts');
  await build({
    configFile,
    root: repoRoot,
    mode: 'production',
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
    plugins: [pinVersion(), recordChunks(sink)],
  });
  fs.writeFileSync(path.join(outDir, '.ds-chunks.json'), `${JSON.stringify(sink)}\n`);
  return sink;
}

/** Build in a child Node with an 8 GiB heap. Returns the child's exit status. */
export function runBuildChild(kind, outDir) {
  const self = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, ['--max-old-space-size=8192', self, kind, outDir], {
    cwd: repoRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (import.meta.main) {
  const [kind, outDir] = process.argv.slice(2);
  if (kind !== 'demo' && kind !== 'main') {
    console.error('usage: node tests/visual/lib/build.mjs demo|main [outDir]');
    process.exit(2);
  }
  const target = path.resolve(outDir ?? (kind === 'demo' ? defaultDemoDir : defaultMainDir));
  // The default ~4 GiB heap runs out on these builds; re-run in an 8 GiB child unless the flag was given.
  if (!process.execArgv.some((arg) => arg.startsWith('--max-old-space-size'))) process.exit(runBuildChild(kind, target));
  const started = Date.now();
  await buildInProcess(kind, target);
  console.log(`[visual-build] ${kind} → ${path.relative(repoRoot, target)} in ${Math.round((Date.now() - started) / 1000)}s`);
}
