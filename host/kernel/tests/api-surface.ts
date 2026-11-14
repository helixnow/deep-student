/**
 * 冻结边界 ③（`host/kernel/api.ts`）的类型快照：用 TypeScript checker 把每个导出序列化成稳定的文本
 * （类型参数、成员、签名、标签），供 api-surface.test.ts 与提交的快照比较。
 *
 * - 按导出名排序；类 / 接口成员按声明顺序；私有成员与 `#` 字段不列。
 * - 类型在本文件之外的引用写成 checker 的短名；实现细节（函数体、初始值）不进快照。
 * - 来自依赖包的导出（`Context`、`Schema`）只记来源包，外加本仓库对它的模块增强成员；继承自依赖包 /
 *   TS lib 的成员不列。
 * - `@stable` / `@deprecated` 标签来自声明或 re-export 语句的 JSDoc。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(ROOT, 'host', 'kernel', 'api.ts');

const TYPE_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
  | ts.TypeFormatFlags.WriteArrowStyleSignature;

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(ROOT, 'tsconfig.host.json');
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, undefined, configPath);
  return { ...parsed.options, noEmit: true };
}

function tagsOf(nodes: readonly ts.Node[]): string[] {
  const tags = new Set<string>();
  for (const node of nodes) {
    for (const tag of ts.getJSDocTags(node)) {
      const name = tag.tagName.text;
      if (name === 'stable' || name === 'deprecated') tags.add(`@${name}`);
    }
  }
  return [...tags].sort();
}

/** re-export 语句（`export { X } from`、`export *`）自身的 JSDoc 也算导出的标签。 */
function exportStatementOf(declaration: ts.Declaration): ts.Node[] {
  if (ts.isExportSpecifier(declaration)) return [declaration.parent.parent];
  return [];
}

function isExternal(declaration: ts.Declaration): boolean {
  return declaration.getSourceFile().fileName.includes('/node_modules/');
}

function isHidden(member: ts.Symbol): boolean {
  if (member.name.startsWith('#') || member.name.startsWith('__@')) return true;
  // 继承自依赖包 / TS lib 的成员（`Error.captureStackTrace` 等）随依赖升级变化，不属于本仓库的接口。
  if ((member.declarations ?? []).every(isExternal)) return true;
  return (member.declarations ?? []).some((declaration) => {
    const flags = ts.getCombinedModifierFlags(declaration);
    return (flags & ts.ModifierFlags.Private) !== 0 || (ts.isPropertyDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && ts.isPrivateIdentifier(declaration.name);
  });
}

function modifiersOf(member: ts.Symbol): string {
  const declaration = member.valueDeclaration ?? member.declarations?.[0];
  if (!declaration) return '';
  const flags = ts.getCombinedModifierFlags(declaration);
  const words: string[] = [];
  if (flags & ts.ModifierFlags.Protected) words.push('protected');
  if (flags & ts.ModifierFlags.Static) words.push('static');
  if (flags & ts.ModifierFlags.Abstract) words.push('abstract');
  if (flags & ts.ModifierFlags.Readonly) words.push('readonly');
  return words.length ? `${words.join(' ')} ` : '';
}

function typeParametersOf(declaration: ts.Declaration | undefined): string {
  const params = declaration && 'typeParameters' in declaration ? (declaration as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters : undefined;
  return params?.length ? `<${params.map((param) => normalize(param.getText())).join(', ')}>` : '';
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')').replace(/,\)/g, ')').trim();
}

class Serializer {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;

  constructor(program: ts.Program) {
    this.program = program;
    this.checker = program.getTypeChecker();
  }

  private type(type: ts.Type, at?: ts.Node): string {
    return this.relativize(this.checker.typeToString(type, at, TYPE_FLAGS));
  }

  private relativize(text: string): string {
    return text.split(ROOT + '/').join('').split(ROOT).join('.');
  }

  private signature(signature: ts.Signature): string {
    return this.relativize(this.checker.signatureToString(signature, undefined, TYPE_FLAGS));
  }

  private members(symbols: readonly ts.Symbol[], at: ts.Node | undefined, indent: string, filter: (member: ts.Symbol) => boolean = () => true): string[] {
    const lines: string[] = [];
    for (const member of symbols) {
      if (isHidden(member) || !filter(member)) continue;
      const optional = member.flags & ts.SymbolFlags.Optional ? '?' : '';
      const tags = tagsOf(member.declarations ?? []);
      const suffix = tags.length ? `  ${tags.join(' ')}` : '';
      const declaration = member.valueDeclaration ?? member.declarations?.[0];
      const memberType = this.checker.getTypeOfSymbolAtLocation(member, declaration ?? at!);
      if (member.flags & ts.SymbolFlags.Method) {
        for (const signature of memberType.getCallSignatures()) lines.push(`${indent}${modifiersOf(member)}${member.name}${optional}${this.signature(signature)}${suffix}`);
      } else if (member.flags & ts.SymbolFlags.GetAccessor && !(member.flags & ts.SymbolFlags.SetAccessor)) {
        lines.push(`${indent}${modifiersOf(member)}get ${member.name}(): ${this.type(memberType, declaration)}${suffix}`);
      } else {
        lines.push(`${indent}${modifiersOf(member)}${member.name}${optional}: ${this.type(memberType, declaration)}${suffix}`);
      }
    }
    return lines;
  }

  private indexAndCalls(type: ts.Type, indent: string): string[] {
    const lines: string[] = [];
    for (const signature of type.getCallSignatures()) lines.push(`${indent}${this.signature(signature)}`);
    for (const signature of type.getConstructSignatures()) lines.push(`${indent}new ${this.signature(signature)}`);
    for (const info of this.checker.getIndexInfosOfType(type)) {
      lines.push(`${indent}${info.isReadonly ? 'readonly ' : ''}[key: ${this.type(info.keyType)}]: ${this.type(info.type)}`);
    }
    return lines;
  }

  private heritage(declaration: ts.ClassDeclaration | ts.InterfaceDeclaration): string {
    return (declaration.heritageClauses ?? []).map((clause) => ` ${normalize(clause.getText())}`).join('');
  }

  serialize(name: string, symbol: ts.Symbol): string[] {
    const target = symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const declarations = target.declarations ?? [];
    const tags = tagsOf([...declarations, ...(symbol.declarations ?? []).flatMap(exportStatementOf)]);
    const tagText = tags.length ? `  ${tags.join(' ')}` : '';
    const first = declarations[0];
    if (first && declarations.some(isExternal)) {
      const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(first.getSourceFile().fileName)?.[1] ?? 'external';
      const kind = target.flags & ts.SymbolFlags.Class ? 'class' : target.flags & ts.SymbolFlags.Interface ? 'interface' : target.flags & ts.SymbolFlags.Function ? 'function' : 'value';
      const augmented = target.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface) ? this.members(this.checker.getPropertiesOfType(this.checker.getDeclaredTypeOfSymbol(target)), undefined, '  ') : [];
      return [`${kind} ${name} = ${pkg}${target.name !== name ? `#${target.name}` : ''}${tagText}`, ...augmented];
    }
    const lines: string[] = [];
    if (target.flags & ts.SymbolFlags.Class) {
      const declaration = declarations.find(ts.isClassDeclaration)!;
      const abstract = ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Abstract ? 'abstract ' : '';
      lines.push(`${abstract}class ${name}${typeParametersOf(declaration)}${this.heritage(declaration)}${tagText}`);
      const staticType = this.checker.getTypeOfSymbolAtLocation(target, declaration);
      for (const signature of staticType.getConstructSignatures()) lines.push(`  constructor${this.signature(signature).replace(/ => .*$/, '')}`);
      lines.push(...this.members(this.checker.getPropertiesOfType(staticType), declaration, '  ', (member) => member.name !== 'prototype'));
      lines.push(...this.members(this.checker.getPropertiesOfType(this.checker.getDeclaredTypeOfSymbol(target)), declaration, '  '));
    } else if (target.flags & ts.SymbolFlags.Interface) {
      const declaration = declarations.find(ts.isInterfaceDeclaration);
      lines.push(`interface ${name}${typeParametersOf(declaration)}${declaration ? this.heritage(declaration) : ''}${tagText}`);
      const type = this.checker.getDeclaredTypeOfSymbol(target);
      lines.push(...this.indexAndCalls(type, '  '), ...this.members(this.checker.getPropertiesOfType(type), declaration, '  '));
    } else if (target.flags & ts.SymbolFlags.TypeAlias) {
      const declaration = declarations.find(ts.isTypeAliasDeclaration)!;
      lines.push(`type ${name}${typeParametersOf(declaration)} = ${this.relativize(normalize(declaration.type.getText()))}${tagText}`);
    } else if (target.flags & ts.SymbolFlags.Enum) {
      lines.push(`enum ${name}${tagText}`);
      for (const member of this.checker.getExportsOfModule(target)) {
        const value = member.valueDeclaration && ts.isEnumMember(member.valueDeclaration) ? this.checker.getConstantValue(member.valueDeclaration) : undefined;
        lines.push(`  ${member.name} = ${JSON.stringify(value)}`);
      }
    } else if (target.flags & ts.SymbolFlags.Function) {
      const type = this.checker.getTypeOfSymbolAtLocation(target, first!);
      for (const signature of type.getCallSignatures()) lines.push(`function ${name}${this.signature(signature)}${tagText}`);
    } else if (target.flags & ts.SymbolFlags.Variable) {
      const declaration = first!;
      const isConst = ts.isVariableDeclaration(declaration) && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
      lines.push(`${isConst ? 'const' : 'let'} ${name}: ${this.type(this.checker.getTypeOfSymbolAtLocation(target, declaration), declaration)}${tagText}`);
    } else {
      lines.push(`unknown ${name} (flags ${target.flags})${tagText}`);
    }
    // 同名的类型与值（`export type X` / `interface X` + `export const X`）：类型已在上面，值单独补一行。
    if (target.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface) && target.flags & ts.SymbolFlags.Variable) {
      const declaration = declarations.find(ts.isVariableDeclaration)!;
      lines.push(`const ${name}: ${this.type(this.checker.getTypeOfSymbolAtLocation(target, declaration), declaration)}`);
    }
    return lines;
  }

  surface(): string {
    const source = this.program.getSourceFile(ENTRY);
    if (!source) throw new Error(`${relative(ROOT, ENTRY)} is not in the program`);
    const moduleSymbol = this.checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`${relative(ROOT, ENTRY)} has no module symbol`);
    const exports = this.checker.getExportsOfModule(moduleSymbol).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const blocks = exports.map((symbol) => this.serialize(symbol.name, symbol).join('\n'));
    return `${blocks.join('\n\n')}\n`;
  }
}

/** 当前 `host/kernel/api.ts` 的导出面。 */
export function apiSurface(): string {
  const program = ts.createProgram({ rootNames: [ENTRY], options: compilerOptions() });
  return new Serializer(program).surface();
}

/** 导出名 → 标签（`@stable` / `@deprecated`），供测试检查标注。 */
export function apiTags(surface: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const block of surface.trim().split('\n\n')) {
    const header = block.split('\n')[0]!;
    const name = /^(?:abstract )?(?:class|interface|type|enum|function|const|let|value|unknown) (\w+)/.exec(header)?.[1];
    if (name) out.set(name, header.match(/@\w+/g) ?? []);
  }
  return out;
}
