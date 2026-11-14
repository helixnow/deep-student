/**
 * 用 TypeScript 编译器检查插件代码（文档里的代码块、脚手架生成的文件），只报告给定文件里的错误。
 *
 * - `host`：按 tsconfig.host.json（Host 半，strict，NodeNext，`.ts` 扩展名导入）。
 * - `ui`：按 examples/tsconfig.json（UI 半：根 tsconfig + `@deepstudent/ui` → src/ui-sdk），另开 strict——
 *   社区插件作者多半开 strict，`src/` 自身不能开，但这里只报告给定文件的错误。
 *
 * 文件可以是磁盘上的真实文件（只给路径），也可以是内存里的虚拟文件（给出内容）：虚拟文件按给定的绝对路径参与
 * 模块解析，相对导入照常解析到仓库里的真实文件，同一批虚拟文件之间也能互相导入。
 */
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './harness';

export type TypecheckMode = 'host' | 'ui';

const CONFIG: Record<TypecheckMode, string> = {
  host: path.join(REPO_ROOT, 'tsconfig.host.json'),
  ui: path.join(REPO_ROOT, 'examples', 'tsconfig.json'),
};

function compilerOptions(mode: TypecheckMode): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(CONFIG[mode], {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`cannot read ${CONFIG[mode]}`);
  return { ...parsed.options, noEmit: true, strict: true, noUnusedLocals: false, noUnusedParameters: false };
}

export interface TypecheckDiagnostic {
  file: string;
  line: number;
  message: string;
}

/**
 * 检查 `files`（绝对路径 → 内容；内容为 null 表示读磁盘），返回这些文件里的语法与类型错误。
 * 行号从 1 开始，相对各自文件。
 */
export function typecheck(files: ReadonlyMap<string, string | null>, mode: TypecheckMode): TypecheckDiagnostic[] {
  const options = compilerOptions(mode);
  const virtual = new Map([...files].filter((e): e is [string, string] => e[1] !== null).map(([f, text]) => [path.resolve(f), text]));
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile, directoryExists } = host;
  // 模块解析先看目录在不在：虚拟文件所在的目录（及其上级）在磁盘上可能不存在。
  const virtualDirs = new Set<string>();
  for (const file of virtual.keys()) {
    for (let dir = path.dirname(file); !virtualDirs.has(dir) && dir !== path.dirname(dir); dir = path.dirname(dir)) virtualDirs.add(dir);
  }
  host.directoryExists = (d) => virtualDirs.has(path.resolve(d)) || (directoryExists ? directoryExists.call(host, d) : ts.sys.directoryExists(d));
  host.fileExists = (f) => virtual.has(path.resolve(f)) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(path.resolve(f)) ?? readFile.call(host, f);
  host.getSourceFile = (f, language, onError, create) => {
    const text = virtual.get(path.resolve(f));
    return text !== undefined ? ts.createSourceFile(f, text, language, true) : getSourceFile.call(host, f, language, onError, create);
  };
  // 仓库外的插件目录没有 node_modules：裸模块名解析不到时按应用仓库解析（同 examples/vitest.config.ts 的 dedupe）。
  const fromRepo = path.join(REPO_ROOT, 'package.json');
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, opts, sourceFile) =>
    literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(sourceFile, literal, opts);
      const resolved = ts.resolveModuleName(literal.text, containingFile, opts, host, undefined, redirected, mode);
      if (resolved.resolvedModule || literal.text.startsWith('.') || path.isAbsolute(literal.text)) return resolved;
      return ts.resolveModuleName(literal.text, fromRepo, opts, host, undefined, redirected, mode);
    });
  const roots = [...files.keys()].map((f) => path.resolve(f));
  const program = ts.createProgram({ rootNames: roots, options, host });
  const out: TypecheckDiagnostic[] = [];
  for (const root of roots) {
    const sf = program.getSourceFile(root);
    if (!sf) {
      out.push({ file: root, line: 0, message: 'not part of the program' });
      continue;
    }
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      const line = d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line + 1;
      out.push({ file: root, line, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
    }
  }
  return out;
}
