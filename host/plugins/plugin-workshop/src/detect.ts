// What a built workshop candidate actually uses, read from its bundles (dist/host.js, dist/ui.js) by the Host.
// Information for the confirmation card only: nothing here refuses a build or asks the user for anything more.
// Static and best effort: it sees literal imports, unbound global calls and literal addresses, not computed ones.
// Dependency-free on purpose (like declared.ts), so the front end's tests can import it.

/**
 * Modules the app shares with community UI halves through its import map. Must equal COMMUNITY_SHARED_MODULES in
 * src/ui-kernel/community.ts (a test compares them); the compiler keeps these as imports in dist/ui.js.
 */
export const SHARED_UI_MODULES = [
  'react', 'react-dom', '@deepstudent/ui', 'i18next',
  '@milkdown/kit/core', '@milkdown/kit/ctx', '@milkdown/kit/utils', '@milkdown/kit/transformer',
  '@milkdown/kit/prose', '@milkdown/kit/prose/state', '@milkdown/kit/prose/view', '@milkdown/kit/prose/model',
  '@milkdown/kit/prose/transform', '@milkdown/kit/prose/commands', '@milkdown/kit/prose/inputrules', '@milkdown/kit/prose/keymap',
] as const;

export interface DetectedUse {
  /** Node built-in modules the Host half imports (`node:` prefix removed, sub-paths kept: `fs/promises`). */
  readonly nodeModules: readonly string[];
  /** Other bare modules left as imports in a bundle. */
  readonly packages: readonly string[];
  /** The bundle calls the network by itself (global fetch / WebSocket / XMLHttpRequest / EventSource or node http/https/net). */
  readonly network: boolean;
  /** Literal http(s) hosts in a bundle that uses the network by itself. */
  readonly hosts: readonly string[];
  /** The Host half uses setInterval (repeats by itself) / setTimeout or setImmediate (runs later by itself). */
  readonly repeats: boolean;
  readonly delays: boolean;
  /**
   * Injected service → method names called on it, split by reading vs changing. For `studyData` the names are
   * `<area>.<method>` (`notes.list`), so the card can say which of the learner's data is read or changed.
   */
  readonly services: Readonly<Record<string, { readonly reads: readonly string[]; readonly writes: readonly string[] }>>;
  /** `pluginSchedule` registrations in plain words (`每天 22:00`, `每 30 分钟`, `每次启动应用时`). */
  readonly schedules: readonly string[];
  /** App events the plugin reacts to (`study/note-saved` …, without the prefix). */
  readonly events: readonly string[];
  /** The UI half's `pluginFiles`: file dialogs and reading / writing the chosen files. */
  readonly files: { readonly pick: boolean; readonly save: boolean; readonly read: boolean };
}

/** Human names of the `studyData` areas. */
export const STUDY_AREAS: Readonly<Record<string, string>> = {
  notes: '笔记', cards: '卡片', questions: '题目', review: '复习记录', todos: '待办', resources: '资料库',
};
/** What the learner does when a `study/*` event fires. */
const STUDY_EVENTS: Readonly<Record<string, string>> = {
  'note-saved': '保存笔记', 'card-reviewed': '复习卡片', 'answer-finished': 'AI 回答完', 'cards-created': '生成卡片',
};
/** Position of a key in a fixed table (unknown keys last), so card lines read in a stable, human order. */
const order = (table: Readonly<Record<string, string>>, key: string) => { const index = Object.keys(table).indexOf(key); return index < 0 ? 99 : index; };
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Node built-ins that are pure computation (no file, process, network or device effect): no card line. */
const QUIET_NODE = new Set(['assert', 'assert/strict', 'buffer', 'crypto', 'events', 'path', 'path/posix', 'path/win32', 'punycode',
  'querystring', 'stream', 'stream/promises', 'stream/web', 'string_decoder', 'url', 'util', 'util/types', 'zlib', 'timers/promises',
  'perf_hooks', 'diagnostics_channel', 'async_hooks']);
const NETWORK_NODE = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises']);
const NODE_BUILTINS = new Set([...QUIET_NODE, ...NETWORK_NODE, 'fs', 'fs/promises', 'child_process', 'os', 'worker_threads', 'cluster',
  'module', 'process', 'readline', 'readline/promises', 'repl', 'tty', 'v8', 'vm', 'inspector', 'inspector/promises', 'wasi', 'sqlite',
  'test', 'timers', 'trace_events', 'sea']);

/** Reading verbs; any other method name counts as a change (unknown names err on the side of telling more). */
const READ_METHOD = /^(?:get|list|read|search|find|query|count|has|load|lookup|stat|exists|is|describe|preview|resolve|peek|watch|subscribe|on|complete|translate|recognize|embed|retrieve)(?:[A-Z_]|$)/;
/** Hosts that appear as XML namespaces, never as network targets. */
const NAMESPACE_HOSTS = new Set(['www.w3.org']);
const MAX_HOSTS = 6;

function importsOf(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g)) found.add(match[1]!);
  return [...found];
}

/** Analyze one or both bundles. `inject` is the module's inject list (method calls are looked up on `ctx.<name>`). */
export function detectUse(bundles: { host?: string; ui?: string }, inject: readonly string[] = []): DetectedUse {
  const nodeModules = new Set<string>(), packages = new Set<string>(), hosts = new Set<string>();
  let network = false;
  for (const [half, code] of Object.entries(bundles) as ['host' | 'ui', string | undefined][]) {
    if (!code) continue;
    let ownNetwork = /(?<![\w$.])(?:fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(|\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b|(?<![\w$])(?:window|globalThis|self)\.fetch\s*\(/.test(code);
    for (const specifier of importsOf(code)) {
      const bare = specifier.replace(/^node:/, '');
      if (half === 'host' && (specifier.startsWith('node:') || NODE_BUILTINS.has(bare))) {
        nodeModules.add(bare);
        if (NETWORK_NODE.has(bare)) ownNetwork = true;
      } else if (half === 'host' || !(SHARED_UI_MODULES as readonly string[]).includes(specifier)) packages.add(specifier);
    }
    if (ownNetwork) {
      network = true;
      for (const match of code.matchAll(/["'`]((?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?)/gi)) {
        const host = match[2]!.toLowerCase();
        if (!NAMESPACE_HOSTS.has(host)) hosts.add(host);
      }
    }
  }
  const host = bundles.host ?? '';
  const services: Record<string, { reads: string[]; writes: string[] }> = {};
  for (const name of inject) {
    if (name === 'log') continue;
    const reads = new Set<string>(), writes = new Set<string>();
    const pattern = new RegExp(`\\.${name.replace(/[$]/g, '\\$')}((?:\\??\\.[A-Za-z_$][\\w$]*)+)\\s*\\(`, 'g');
    for (const match of host.matchAll(pattern)) {
      const path = match[1]!.split('.').map(part => part.replace('?', '')).filter(Boolean);
      const method = path[path.length - 1]!;
      const label = name === 'studyData' && path.length > 1 ? `${path[0]}.${method}` : method;
      (READ_METHOD.test(method) ? reads : writes).add(label);
    }
    if (reads.size || writes.size) services[name] = { reads: [...reads].sort(), writes: [...writes].sort() };
  }
  const schedules = new Set<string>();
  const time = /^\d{1,2}:\d{2}$/;
  const scheduled = /\.(daily|weekly|every|onStartup)\s*\(\s*["'`][^"'`]*["'`]\s*(?:,\s*([^,)]+))?(?:,\s*([^,)]+))?/g;
  if (inject.includes('pluginSchedule')) for (const match of host.matchAll(scheduled)) {
    const [, kind, first, second] = match;
    const text = (value?: string) => value?.trim().replace(/^["'`]|["'`]$/g, '') ?? '';
    if (kind === 'daily') schedules.add(time.test(text(first)) ? `每天 ${text(first)}` : '每天');
    else if (kind === 'weekly') schedules.add(`每${WEEKDAYS[Number(text(first))] ?? '周'}${time.test(text(second)) ? ` ${text(second)}` : ''}`);
    else if (kind === 'every') schedules.add(/^\d+$/.test(text(first)) ? `每 ${text(first)} 分钟` : '每隔一段时间');
    else schedules.add('每次启动应用时');
  }
  if (inject.includes('pluginSchedule') && !schedules.size && /\.register\s*\(/.test(host)) schedules.add('按设定的时间');
  const events = new Set<string>();
  for (const code of [host, bundles.ui ?? '']) for (const match of code.matchAll(/["'`]study\/([a-z-]+)["'`]/g)) events.add(match[1]!);
  const ui = bundles.ui ?? '';
  const files = { pick: /\bpluginFiles\d*\.(?:pick|pickFolder)\s*\(/.test(ui), save: /\bpluginFiles\d*\.save(?:Text|Bytes)\s*\(/.test(ui),
    read: /\bpluginFiles\d*\.read(?:Text|Bytes)\s*\(/.test(ui) };
  return {
    schedules: [...schedules], events: [...events].sort((a, b) => order(STUDY_EVENTS, a) - order(STUDY_EVENTS, b)), files,
    nodeModules: [...nodeModules].sort(), packages: [...packages].sort(), network, hosts: [...hosts].sort(),
    repeats: /(?<![\w$.])setInterval\s*\(/.test(host), delays: /(?<![\w$.])(?:setTimeout|setImmediate)\s*\(/.test(host), services,
  };
}

/** Plain-language card lines for what was detected (services are named by the caller, see declared.ts). */
export function detectedLines(use: DetectedUse, serviceName: (name: string) => string): string[] {
  const lines: string[] = [];
  const has = (...names: string[]) => names.some(name => use.nodeModules.includes(name));
  if (has('fs', 'fs/promises')) lines.push('能读写你电脑上的文件');
  if (has('child_process', 'cluster')) lines.push('能运行你电脑上的其他程序');
  if (has('os')) lines.push('能读取电脑的系统信息（用户名、目录、硬件等）');
  if (has('worker_threads')) lines.push('会另开后台线程运行代码');
  if (has('vm', 'inspector', 'inspector/promises', 'repl', 'v8', 'module')) lines.push('能动态加载或执行代码');
  if (has('readline', 'readline/promises', 'tty', 'process')) lines.push('能直接读写应用进程的输入输出');
  if (has('sqlite')) lines.push('能打开和修改数据库文件');
  if (use.network) {
    for (const host of use.hosts.slice(0, MAX_HOSTS)) lines.push(`能访问 ${host}`);
    if (use.hosts.length > MAX_HOSTS) lines.push(`还能访问另外 ${use.hosts.length - MAX_HOSTS} 个网站`);
    lines.push(use.hosts.length ? '能自己联网（不限于上面列出的网站）' : '能自己联网，访问任意网站');
  }
  if (use.repeats) lines.push('会在后台定时运行');
  else if (use.delays) lines.push('会在稍后自动执行操作（不需要你点按钮）');
  for (const schedule of use.schedules) lines.push(`会按时自动运行（${schedule}）`);
  if (use.events.length) lines.push(`会在你${use.events.map(event => STUDY_EVENTS[event] ?? event).join('、')}时自动运行`);
  if (use.files.pick) lines.push('会让你选择文件');
  if (use.files.read) lines.push('能读取你选择的文件');
  if (use.files.save) lines.push('会让你选择保存位置并写入文件');
  for (const [name, { reads, writes }] of Object.entries(use.services)) {
    if (name === 'studyData') {
      const areas = (labels: readonly string[]) => [...new Set(labels.map(label => label.split('.')[0]!))]
        .sort((a, b) => order(STUDY_AREAS, a) - order(STUDY_AREAS, b)).map(area => STUDY_AREAS[area] ?? area);
      if (writes.length) lines.push(`会修改你的${areas(writes).join('、')}`);
      if (reads.length) lines.push(`会读取你的${areas(reads).join('、')}`);
      continue;
    }
    if (name === 'pluginSecrets') {
      if (reads.length) lines.push('会读取你保存的密钥');
      if (writes.length) lines.push('会保存或删除你的密钥');
      continue;
    }
    if (name === 'pluginNotify' || name === 'pluginSchedule') continue; // said by the service sentence and the schedule lines
    const human = serviceName(name);
    if (writes.length) lines.push(`会修改「${human}」里的内容（${writes.join('、')}）`);
    if (reads.length) lines.push(`会读取「${human}」（${reads.join('、')}）`);
  }
  for (const name of use.packages) lines.push(`使用外部模块「${name}」`);
  return lines;
}
