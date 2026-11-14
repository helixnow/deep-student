#!/usr/bin/env node
/**
 * Gate: does the built demo shell boot, and is the chunk graph free of static import cycles?
 *
 *   bin/heavy node tests/visual/lib/boot-check.mjs --build          # build the demo in a scratch dir, check, delete it
 *   bin/heavy node tests/visual/lib/boot-check.mjs --build --main   # also build the production main app and scan it
 *   node tests/visual/lib/boot-check.mjs [--dist DIR]               # check an existing demo build (default dist-demo/)
 *   node tests/visual/lib/boot-check.mjs --static --dist DIR        # cycle scan only, no browser (any build, e.g. main)
 *
 * Exit 0 = pass, 1 = cycle or boot failure, 2 = usage or build error. `--keep` keeps the scratch build,
 * `--json FILE` writes the findings.
 *
 * A static cycle between chunks lets one chunk run before a module it imports has initialised (seen on INT
 * 68d37526: `ui-boot ⇄ vendor-i18n ⇄ vendor-micro ⇄ vendor-react`, page error `Cannot read properties of
 * undefined (reading 'createContext')`, empty #root). For each cycle the report prints the shortest loop,
 * the bindings each edge imports, and the source modules inside each chunk on the loop (from the
 * `.ds-chunks.json` table that `lib/build.mjs` records). The boot step loads `demo.html` and
 * `demo-app.html?app=chat` and fails when `#root` stays empty, with the page errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultDemoDir, repoRoot, runBuildChild, visualRoot } from './build.mjs';

const ENTRIES = [
  { entry: 'demo.html', root: '#root' },
  { entry: 'demo-app.html?app=chat', root: '#root' },
];

/** Static chunk edges: `import{…}from"./x.js"`, `import"./x.js"`, `export{…}from"./x.js"` (not `import("./x.js")`). */
function readChunkGraph(dist) {
  const dir = path.join(dist, 'assets');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.js'));
  const edges = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const targets = new Map();
    for (const match of text.matchAll(/(?:import|export)\s*(?:([\w$*{}\s,]*?)\s*from)?\s*"\.\/([^"]+\.js)"/g)) {
      const [, clause, target] = match;
      if (target === file) continue;
      const bindings = targets.get(target) ?? new Set();
      const named = clause?.match(/\{([^}]*)\}/)?.[1];
      for (const name of named ? named.split(',') : []) if (name.trim()) bindings.add(name.trim().replace(/\s+as\s+/, ' as '));
      if (clause && !named && clause.trim()) bindings.add(clause.trim());
      targets.set(target, bindings);
    }
    edges.set(file, targets);
  }
  return edges;
}

/** Strongly connected components (size > 1); iterative Tarjan, chunk graphs overflow a recursive walk. */
function stronglyConnected(edges) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const enter = (node) => { index.set(node, counter); low.set(node, counter); counter++; stack.push(node); onStack.add(node); };
  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    enter(start);
    const work = [[start, [...edges.get(start).keys()].filter((t) => edges.has(t)), 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, targets] = frame;
      if (frame[2] < targets.length) {
        const target = targets[frame[2]++];
        if (!index.has(target)) {
          enter(target);
          work.push([target, [...edges.get(target).keys()].filter((t) => edges.has(t)), 0]);
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node), index.get(target)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        let member;
        do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== node);
        if (component.length > 1) components.push(component.sort());
      }
    }
  }
  return components;
}

/** Shortest loop through `start` inside one component (BFS). */
function shortestLoop(edges, component, start) {
  const members = new Set(component);
  const previous = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const target of edges.get(node).keys()) {
      if (!members.has(target)) continue;
      if (target === start) {
        const loop = [node];
        for (let at = previous.get(node); at; at = previous.get(at)) loop.unshift(at);
        return [...loop, start];
      }
      if (!previous.has(target)) { previous.set(target, node); queue.push(target); }
    }
  }
  return [start];
}

function loadChunkTable(dist) {
  const file = path.join(dist, '.ds-chunks.json');
  if (!fs.existsSync(file)) return null;
  const table = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(table.chunks.map((chunk) => [path.basename(chunk.fileName), chunk]));
}

const relId = (id) => {
  const virtual = id.startsWith('\0');
  const [file, query] = (virtual ? id.slice(1) : id).split('?');
  const shown = path.isAbsolute(file) ? path.relative(repoRoot, file).replace(/^(\.\.\/)+[^/]+\/node_modules\//, 'node_modules/') : file;
  return `${virtual ? '\\0' : ''}${shown}${query ? `?${query}` : ''}`;
};

/** Cycles in a built app, each with its loop, edge bindings and chunk contents. */
export function chunkCycles(dist) {
  const edges = readChunkGraph(dist);
  const table = loadChunkTable(dist);
  return stronglyConnected(edges).map((component) => {
    const start = component.find((file) => /^ui-boot/.test(file)) ?? component[0];
    const loop = shortestLoop(edges, component, start);
    const steps = loop.slice(0, -1).map((from, i) => ({ from, to: loop[i + 1], imports: [...edges.get(from).get(loop[i + 1])].sort() }));
    const chunks = Object.fromEntries(component.map((file) => {
      const modules = Object.keys(table?.get(file)?.modules ?? {}).map(relId);
      // Rollup's shared CommonJS helpers first: a vendor chunk importing them from an app chunk is the usual cause.
      const virtual = modules.filter((id) => id.startsWith('\\0')).sort((a, b) => Number(b.includes('commonjsHelpers')) - Number(a.includes('commonjsHelpers')));
      return [file, { modules: modules.length, virtual, sample: modules.filter((id) => !id.startsWith('\\0')).slice(0, 3) }];
    }));
    return { members: component, loop, steps, chunks: table ? chunks : null };
  });
}

export function formatCycle(cycle) {
  const lines = [`static import cycle between chunks: ${cycle.members.join(' ⇄ ')}`, `    loop: ${cycle.loop.join(' → ')}`];
  for (const step of cycle.steps) {
    const shown = step.imports.slice(0, 8).join(', ');
    lines.push(`      ${step.from} imports {${shown}${step.imports.length > 8 ? `, … ${step.imports.length - 8} more` : ''}} from ${step.to}`);
  }
  if (cycle.chunks) {
    for (const [file, info] of Object.entries(cycle.chunks)) {
      const parts = [`${info.modules} modules`];
      if (info.virtual.length) parts.push(`virtual: ${info.virtual.slice(0, 3).join(', ')}${info.virtual.length > 3 ? ` (+${info.virtual.length - 3})` : ''}`);
      if (info.sample.length) parts.push(`e.g. ${info.sample.join(', ')}`);
      lines.push(`    ${file}: ${parts.join('; ')}`);
    }
  } else {
    lines.push('    (no .ds-chunks.json next to the build: rebuild with tests/visual/lib/build.mjs to see chunk contents)');
  }
  return lines.join('\n');
}

export async function bootProblems(dist) {
  const [{ chromium }, { serveDirectory }] = await Promise.all([import('playwright'), import('./serve.mjs')]);
  const problems = [];
  const server = await serveDirectory(dist);
  const browser = await chromium.launch();
  try {
    for (const { entry, root } of ENTRIES) {
      const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort('internetdisconnected'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message.split('\n')[0]));
      await page.goto(`${server.url}/${entry}`, { waitUntil: 'load', timeout: 60_000 });
      const mounted = await page.waitForFunction((selector) => (document.querySelector(selector)?.childElementCount ?? 0) > 0, root, { timeout: 20_000 })
        .then(() => true, () => false);
      if (!mounted) problems.push(`${entry}: ${root} stayed empty${errors.length ? `; page errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return problems;
}

/** Preflight used by regress.mjs: problems as printable strings (empty = boots). */
export async function bootCheck(dist = defaultDemoDir) {
  return [...chunkCycles(dist).map(formatCycle), ...await bootProblems(dist)];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const value = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const known = new Set(['--build', '--main', '--static', '--keep', '--dist', '--json']);
  const unknown = argv.filter((arg, i) => arg.startsWith('--') && !known.has(arg) && !['--dist', '--json'].includes(argv[i - 1]));
  if (unknown.length || (argv.includes('--build') && value('--dist'))) {
    console.error('usage: boot-check.mjs [--build [--main] [--keep]] | [--dist DIR] [--static]  [--json FILE]');
    process.exit(2);
  }
  const scratch = path.join(visualRoot, '.out/boot-check');
  const builds = [];
  if (argv.includes('--build')) {
    builds.push({ kind: 'demo', dist: path.join(scratch, 'demo'), boot: true });
    if (argv.includes('--main')) builds.push({ kind: 'main', dist: path.join(scratch, 'main'), boot: false });
  } else {
    builds.push({ kind: 'given', dist: path.resolve(value('--dist') ?? defaultDemoDir), boot: !argv.includes('--static') });
  }
  const report = [];
  let failed = false;
  try {
    for (const build of builds) {
      if (build.kind !== 'given') {
        console.log(`[boot-check] building ${build.kind} → ${path.relative(repoRoot, build.dist)}`);
        const status = runBuildChild(build.kind, build.dist);
        if (status !== 0) {
          console.error(`[boot-check] ${build.kind} build failed (exit ${status})`);
          process.exitCode = 2;
          break;
        }
      }
      if (!fs.existsSync(path.join(build.dist, 'assets'))) {
        console.error(`[boot-check] no build at ${build.dist} (build it with \`bin/heavy node tests/visual/lib/build.mjs demo\` or pass --build)`);
        process.exitCode = 2;
        break;
      }
      const cycles = chunkCycles(build.dist);
      const boot = build.boot ? await bootProblems(build.dist) : [];
      const label = path.relative(process.cwd(), build.dist) || build.dist;
      for (const cycle of cycles) console.log(`  ✗ ${formatCycle(cycle)}`);
      for (const problem of boot) console.log(`  ✗ ${problem}`);
      const ok = !cycles.length && !boot.length;
      failed ||= !ok;
      console.log(`[boot-check] ${ok ? 'passed' : 'FAILED'} (${label}${build.boot ? '' : ', static scan only'}): ${cycles.length} cycle(s)${build.boot ? `, ${boot.length} boot problem(s)` : ''}`);
      report.push({ dist: label, kind: build.kind, cycles, boot, ok });
    }
  } finally {
    if (value('--json')) fs.writeFileSync(path.resolve(value('--json')), `${JSON.stringify(report, null, 2)}\n`);
    if (builds.some((build) => build.kind !== 'given') && !argv.includes('--keep')) fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!process.exitCode) process.exitCode = failed ? 1 : 0;
}
