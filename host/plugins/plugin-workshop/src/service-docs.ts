// Live Host service reference for the workshop's discovery tools (dstu_plugin_api_list / dstu_plugin_api_read).
//
// Like an inspector over the app's real types: every service a plugin can `inject` is declared on Cordis' `Context`
// in some `host/{plugins,platform}/<name>/api.ts`. This reads those declarations from the shipped sources and
// returns each service's interface members (signature + first doc sentence), following the types its members use
// (same file, relative imports and `import('…')` types) a couple of levels deep. A light TypeScript reader, not a
// compiler: good enough to write calls against, never used to decide anything.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export interface ServiceMember { name: string; signature: string; doc?: string }
export interface ServiceType { name: string; source: string; doc?: string; kind: 'interface' | 'type' | 'class'; extends?: string[]; members?: ServiceMember[]; definition?: string }
export interface ServiceDoc {
  service: string; source: string; type: string; doc?: string;
  members: ServiceMember[];
  /** Types the members refer to, by name (interfaces with their members, aliases with their definition). */
  types: Record<string, ServiceType>;
}

const MAX_SIGNATURE = 400, MAX_DOC = 200, MAX_TYPES = 24, MAX_DEPTH = 2;

function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === '}' || ch === ')' || ch === ']') { if (stack.pop() !== ch) return -1; if (!stack.length) return i; }
  }
  return -1;
}

const docText = (raw: string | undefined) => {
  if (!raw) return undefined;
  const text = raw.replace(/^\/\*\*|\*\/$/g, '').split('\n').map(line => line.replace(/^\s*\*\s?/, '')).join(' ')
    .replace(/\{@link\s+([^}\s]+)[^}]*\}/g, '$1').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const sentence = /^(.+?[。.!?！？])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > MAX_DOC ? `${sentence.slice(0, MAX_DOC - 1)}…` : sentence;
};
const squash = (text: string) => {
  const flat = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SIGNATURE ? `${flat.slice(0, MAX_SIGNATURE - 1)}…` : flat;
};

/** Members of an interface/class/object-type body: split at `;`, `,` or new lines at depth 0, keeping the leading JSDoc. */
export function parseMembers(body: string): ServiceMember[] {
  const members: ServiceMember[] = [];
  let depth = 0, start = 0, doc: string | undefined;
  const flush = (end: number) => {
    const raw = body.slice(start, end);
    const docs = [...raw.matchAll(/\/\*\*[\s\S]*?\*\//g)];
    const ownDoc = docs.length ? docs[docs.length - 1]![0] : doc;
    const text = squash(raw);
    start = end + 1; doc = undefined;
    if (!text || text.startsWith('[') && !text.includes(':')) return;
    const name = /^(?:readonly\s+|static\s+|async\s+|get\s+|set\s+|public\s+)*(['"]?[\w$@.-]+['"]?|\[[^\]]+\])/.exec(text)?.[1];
    if (!name || ['private', 'protected', 'constructor'].includes(name) || name.startsWith('#')) return;
    members.push({ name: name.replace(/^['"]|['"]$/g, ''), signature: text.replace(/[;,]$/, ''), ...(docText(ownDoc) ? { doc: docText(ownDoc) } : {}) });
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '/' && body[i + 1] === '*') { const end = body.indexOf('*/', i + 2); i = end < 0 ? body.length : end + 1; continue; }
    if (ch === '/' && body[i + 1] === '/') { const end = body.indexOf('\n', i); i = end < 0 ? body.length : end - 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < body.length && body[i] !== ch; i++) if (body[i] === '\\') i++; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (depth === 0 && (ch === ';' || ch === ',')) flush(i);
    else if (depth === 0 && ch === '\n') {
      const before = body.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
      const after = body.slice(i + 1).trimStart();
      if (before && !/[|&,(:=<>?]$/.test(before) && !/^[|&.?:=>)]/.test(after) && !/^\/\*\*/.test(before.slice(-3))) flush(i);
    }
  }
  flush(body.length);
  return members;
}

class SourceReader {
  readonly root: string;
  private readonly cache = new Map<string, Promise<string | null>>();
  constructor(root: string) { this.root = root; }
  text(file: string): Promise<string | null> {
    let cached = this.cache.get(file);
    if (!cached) { cached = readFile(file, 'utf8').catch(() => null); this.cache.set(file, cached); }
    return cached;
  }
  rel(file: string) { return relative(this.root, file).replaceAll('\\', '/'); }
  async resolveModule(from: string, specifier: string): Promise<string | null> {
    if (!specifier.startsWith('.')) return null;
    const base = resolve(dirname(from), specifier);
    for (const file of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) if (file.endsWith('.ts') && await this.text(file) !== null) return file;
    return null;
  }
  /** Find a named type in a file, following relative imports and re-exports (a few hops). */
  async findType(file: string, name: string, hops = 3): Promise<ServiceType | null> {
    const text = await this.text(file);
    if (text === null) return null;
    const declaration = new RegExp(`(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/\\s*)?(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(interface|class|type)\\s+${name}\\b([^{=;]*)(=|\\{)`, 'g');
    for (const match of text.matchAll(declaration)) {
      const kind = match[2] as ServiceType['kind'];
      const at = match.index! + match[0].length - 1;
      const doc = docText(match[1]);
      const head = match[3] ?? '';
      const ext = /\b(?:extends|implements)\s+([^{]+)/.exec(head)?.[1]?.split(',').map(part => part.trim().replace(/<.*$/, '')).filter(Boolean);
      if (match[4] === '{') {
        const close = matchClose(text, at);
        if (close < 0) continue;
        return { name, source: this.rel(file), kind, ...(doc ? { doc } : {}), ...(ext?.length ? { extends: ext } : {}), members: parseMembers(text.slice(at + 1, close)) };
      }
      // type alias: up to the `;` at depth 0
      let i = at + 1, depth = 0;
      for (; i < text.length; i++) {
        const ch = text[i]!;
        if ('{(['.includes(ch)) depth++; else if ('})]'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) break;
        else if (ch === '\n' && depth === 0 && /^\s*(?:export|import|interface|type|const|function|declare|\/\*\*|\/\/)/.test(text.slice(i + 1))) break;
      }
      const definition = text.slice(at + 1, i);
      const objectType = /^\s*\{/.test(definition) && matchClose(definition, definition.indexOf('{')) === definition.trimEnd().length - 1;
      return { name, source: this.rel(file), kind, ...(doc ? { doc } : {}),
        ...(objectType ? { members: parseMembers(definition.slice(definition.indexOf('{') + 1, definition.trimEnd().length - 1)) } : { definition: squash(definition) }) };
    }
    if (hops <= 0) return null;
    for (const match of text.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      for (const part of match[1]!.split(',')) {
        const [original, alias] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/);
        if ((alias ?? original) !== name || !original) continue;
        const next = await this.resolveModule(file, match[2]!);
        if (next) { const found = await this.findType(next, original, hops - 1); if (found) return found.name === name ? found : { ...found, name }; }
      }
    }
    for (const match of text.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
      const next = await this.resolveModule(file, match[1]!);
      if (next) { const found = await this.findType(next, name, hops - 1); if (found) return found; }
    }
    return null;
  }
}

const BUILTIN_TYPES = new Set(['string', 'number', 'boolean', 'unknown', 'void', 'never', 'any', 'null', 'undefined', 'object', 'Promise',
  'Record', 'Readonly', 'ReadonlyArray', 'Array', 'Partial', 'Pick', 'Omit', 'Map', 'Set', 'Date', 'Uint8Array', 'AbortSignal', 'Error',
  'Required', 'NonNullable', 'ReturnType', 'Parameters', 'Awaited', 'Exclude', 'Extract', 'ArrayBuffer', 'URL', 'RegExp', 'Function',
  'ReadonlyMap', 'ReadonlySet', 'Iterable', 'AsyncIterable', 'AsyncIterableIterator', 'IterableIterator', 'Context', 'T', 'K', 'V']);

/** Every service declared on Cordis' `Context` in the app's api.ts files: name → where and as which type. */
export class ServiceDocs {
  private readonly reader: SourceReader;
  private index: Promise<Map<string, { file: string; typeExpr: string; doc?: string }>> | null = null;
  constructor(root: string) { this.reader = new SourceReader(root); }

  declarations(): Promise<Map<string, { file: string; typeExpr: string; doc?: string }>> {
    this.index ??= (async () => {
      const found = new Map<string, { file: string; typeExpr: string; doc?: string }>();
      // api.ts of every package first; then other top-level and types/ files (vfs declares its services in portable.ts).
      const primary: string[] = [], secondary: string[] = [];
      for (const area of ['host/plugins', 'host/platform']) {
        let names: string[] = [];
        try { names = (await readdir(join(this.reader.root, area), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
        catch { continue; }
        for (const name of names) {
          const dir = join(this.reader.root, area, name);
          primary.push(join(dir, 'api.ts'));
          for (const sub of ['', 'types']) {
            let files: string[] = [];
            try { files = (await readdir(join(dir, sub))).filter(file => file.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(file) && !(sub === '' && file === 'api.ts')).sort(); }
            catch { continue; }
            for (const file of files) secondary.push(join(dir, sub, file));
          }
        }
      }
      {
        for (const file of [...primary, ...secondary]) {
          const text = await this.reader.text(file);
          if (!text) continue;
          for (const match of text.matchAll(/interface\s+Context\s*\{/g)) {
            const open = match.index! + match[0].length - 1, close = matchClose(text, open);
            if (close < 0) continue;
            for (const member of parseMembers(text.slice(open + 1, close))) {
              if (!/^[a-z][A-Za-z0-9]*$/.test(member.name) || found.has(member.name)) continue;
              const typeExpr = member.signature.replace(/^(?:readonly\s+)?[\w$]+\??\s*:\s*/, '');
              found.set(member.name, { file, typeExpr, ...(member.doc ? { doc: member.doc } : {}) });
            }
          }
        }
      }
      return found;
    })();
    return this.index;
  }

  /** The documented type of one service, or null when no api.ts declares it. */
  async read(service: string): Promise<ServiceDoc | null> {
    const declaration = (await this.declarations()).get(service);
    if (!declaration) return null;
    const { file, typeExpr } = declaration;
    const imported = /^import\(\s*['"]([^'"]+)['"]\s*\)\.([\w$]+)/.exec(typeExpr);
    const typeName = imported ? imported[2]! : /^[\w$]+/.exec(typeExpr)?.[0] ?? typeExpr;
    const typeFile = imported ? await this.reader.resolveModule(file, imported[1]!) ?? file : file;
    const root = await this.reader.findType(typeFile, typeName);
    const types: Record<string, ServiceType> = {};
    // Breadth-first over referenced names, a couple of levels deep.
    const parts = typeExpr.split('&').slice(1).map(part => /^\s*([\w$]+)/.exec(part)?.[1]).filter((name): name is string => Boolean(name));
    let frontier = [...parts, ...(root?.extends ?? []), ...referenced(root)].map(name => ({ name, from: root ? join(this.reader.root, root.source) : typeFile }));
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const next: typeof frontier = [];
      for (const { name, from } of frontier) {
        if (types[name] || name === typeName || BUILTIN_TYPES.has(name) || Object.keys(types).length >= MAX_TYPES) continue;
        const found = await this.reader.findType(from, name);
        if (!found) continue;
        types[name] = found;
        for (const child of [...(found.extends ?? []), ...referenced(found)]) next.push({ name: child, from: join(this.reader.root, found.source) });
      }
      frontier = next;
    }
    return { service, source: this.reader.rel(file), type: typeExpr, ...(declaration.doc ?? root?.doc ? { doc: declaration.doc ?? root?.doc } : {}),
      members: root?.members ?? [], types };
  }
}

function referenced(type: ServiceType | null): string[] {
  if (!type) return [];
  const text = [...(type.members ?? []).map(member => member.signature.replace(/^[^:(]*/, '')), type.definition ?? ''].join(' ');
  return [...new Set([...text.matchAll(/\b([A-Z][\w$]*)\b/g)].map(match => match[1]!))];
}
