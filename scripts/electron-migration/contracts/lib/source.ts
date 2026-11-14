// 源码快照。默认读 git HEAD 中已提交的内容（共享工作区里常有他人未提交的改动；
// 生成物只反映已提交源码，才能与 CI 干净检出逐字节一致，`--check` 才有意义）。
// 测试用 MemorySource 注入小段 Rust。路径一律为仓库相对路径（`/` 分隔）。
import { execFileSync } from 'node:child_process';

export interface SourceTree {
  /** 以 prefix 开头的文件（排序）。 */
  list(prefix: string): string[];
  exists(rel: string): boolean;
  read(rel: string): string;
}

export class MemorySource implements SourceTree {
  readonly files: Map<string, string>;
  constructor(files: Record<string, string>) { this.files = new Map(Object.entries(files)); }
  list(prefix: string): string[] { return [...this.files.keys()].filter((f) => f.startsWith(prefix)).sort(); }
  exists(rel: string): boolean { return this.files.has(rel); }
  read(rel: string): string {
    const t = this.files.get(rel);
    if (t === undefined) throw new Error(`no such file: ${rel}`);
    return t;
  }
}

/** git HEAD 快照：一次 ls-tree 列文件，按需批量 cat-file 读取。 */
export class GitHeadSource implements SourceTree {
  private readonly root: string;
  private readonly all: Set<string>;
  private readonly cache = new Map<string, string>();
  constructor(root: string, prefixes: string[]) {
    this.root = root;
    const out = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...prefixes], { cwd: root, maxBuffer: 1 << 28 });
    this.all = new Set(out.toString('utf8').split('\0').filter(Boolean));
  }
  list(prefix: string): string[] { return [...this.all].filter((f) => f.startsWith(prefix)).sort(); }
  exists(rel: string): boolean { return this.all.has(rel); }
  /** 预读一批文件（一次 git 进程）。 */
  prefetch(paths: string[]): void {
    const todo = paths.filter((p) => this.all.has(p) && !this.cache.has(p));
    if (!todo.length) return;
    const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: this.root, input: todo.map((p) => `HEAD:${p}`).join('\n') + '\n', maxBuffer: 1 << 30 });
    let pos = 0;
    for (const p of todo) {
      const nl = buf.indexOf(10, pos);
      const header = buf.subarray(pos, nl).toString('utf8');
      pos = nl + 1;
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m) throw new Error(`git cat-file: cannot read HEAD:${p} (${header})`);
      const size = Number(m[2]);
      this.cache.set(p, buf.subarray(pos, pos + size).toString('utf8'));
      pos += size + 1;
    }
  }
  read(rel: string): string {
    if (!this.cache.has(rel)) this.prefetch([rel]);
    const t = this.cache.get(rel);
    if (t === undefined) throw new Error(`not tracked at HEAD: ${rel}`);
    return t;
  }
}
