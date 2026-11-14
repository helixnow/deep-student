/**
 * Build-time official UI plugin table (FE-A5, FRONTEND-PLUGINIZATION §2.4): `vite.config.ts` replaces
 * `src/ui-plugins/official/plugins.ts` with the virtual module rendered here, which imports only the official plugins
 * that run on the target platform (`VITE_DS_PLATFORM`, default `desktop`) — and, in production builds, none of the
 * `devOnly` ones — so the other plugins' directories are not in that build at all. The kernel applies the same rules
 * at install time; this only keeps the code out of the bundle.
 *
 * Runs in Node (Vite config), never in the app. `meta.platforms`, `meta.devOnly` and `meta.slots` of an official plugin
 * are read from source, so every official plugin follows one convention (src/ui-sdk/README.md §8), enforced here — and thus
 * in every production build and in `official-plugins.test.ts`: the default export is one
 * `defineUiPlugin({ meta: { … }, apply })` call (optionally wrapped to add `order`), `meta` is an inline object
 * literal, and meta fields such as `devOnly` are written only inside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { UI_PLATFORMS, type UiPlatformKind, type UiPluginMeta } from '../ui-kernel/meta';

export const OFFICIAL_PLUGINS_MODULE = 'src/ui-plugins/official/plugins.ts';
export const OFFICIAL_PLUGINS_VIRTUAL_ID = '\0ds-official-plugins';

export interface OfficialPluginDeclaration {
  /** Repository-relative `src/ui-plugins/official/<dir>/index.ts`. */
  file: string;
  id: string;
  platforms?: readonly UiPlatformKind[];
  devOnly: boolean;
  slots?: readonly string[];
}

export class OfficialPluginTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficialPluginTableError';
  }
}

/** Every `UiPluginMeta` field: a plugin-level property with one of these names is a meta field written in the wrong place. */
const META_FIELDS: Record<keyof UiPluginMeta, true> = {
  id: true, version: true, apiVersion: true, platforms: true, host: true, requiresHost: true, requires: true, i18n: true, devOnly: true, core: true,
  slots: true,
};
const isMetaField = (name: string) => Object.hasOwn(META_FIELDS, name);

const CONVENTION = "export default defineUiPlugin({ meta: { id: 'dstu.ui.<name>', … }, apply(ctx) { … } })";

const memberName = (member: ts.ObjectLiteralElementLike): string | undefined =>
  member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : undefined;

const findProperty = (object: ts.ObjectLiteralExpression, name: string) =>
  object.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && memberName(property) === name);

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

const isDefineUiPluginCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineUiPlugin';

/** `<file>:<line>:<col>: <problem>` plus the fix, so a failing build points at the offending property. */
function fail(sourceFile: ts.SourceFile, node: ts.Node | undefined, problem: string, fix: string): never {
  let where = '';
  if (node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    where = `:${line + 1}:${character + 1}`;
  }
  throw new OfficialPluginTableError(`${sourceFile.fileName}${where}: ${problem}\n  fix: ${fix}\n  (official UI plugin convention: src/ui-sdk/README.md §8)`);
}

/** The default export's expression, following one `const plugin = …; export default plugin`. */
function defaultExport(sourceFile: ts.SourceFile): ts.Expression | undefined {
  const statement = sourceFile.statements.find(ts.isExportAssignment);
  if (!statement || statement.isExportEquals) return undefined;
  const expression = unwrap(statement.expression);
  if (!ts.isIdentifier(expression)) return expression;
  for (const declarations of sourceFile.statements.filter(ts.isVariableStatement)) {
    const match = declarations.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === expression.text);
    if (match?.initializer) return match.initializer;
  }
  return undefined;
}

/**
 * The `meta` of the plugin a `src/ui-plugins/official/<dir>/index.ts` exports by default. The default export must
 * contain exactly one `defineUiPlugin({ meta: { … }, apply })` call — directly, or wrapped as
 * `Object.assign(defineUiPlugin(…), { order })` / `{ ...defineUiPlugin(…), order }`. Plugins defined inside functions
 * (paired halves installed from `apply`) or outside the default export do not count.
 *
 * Rejected with a fix hint: a meta field (`devOnly`, `platforms`, …) written outside `meta` — the kernel reads only
 * `plugin.meta`, so such a field is silently ignored (a top-level `devOnly` ships the plugin in production); a `meta`
 * that is not an inline object literal of `name: value` members; and a bare plugin object literal, which skips
 * `defineUiPlugin`'s excess-property check — the reason the misplaced `devOnly` above compiled at all.
 */
export function readOfficialPluginDeclaration(file: string, source: string): OfficialPluginDeclaration {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exported = defaultExport(sourceFile);
  if (!exported) fail(sourceFile, undefined, 'no default export', CONVENTION);

  // Plugin-level object literals: the wrappers around the defineUiPlugin call (property values are not descended into).
  const calls: ts.CallExpression[] = [];
  const wrappers: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (isDefineUiPluginCall(node)) {
      calls.push(node);
    } else if (ts.isObjectLiteralExpression(node)) {
      wrappers.push(node);
      for (const member of node.properties) if (ts.isSpreadAssignment(member)) visit(member.expression);
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(exported);

  const misplaced = (members: readonly ts.ObjectLiteralElementLike[]) => {
    for (const member of members) {
      const name = memberName(member);
      if (name === undefined || name === 'meta' || !isMetaField(name)) continue;
      fail(
        sourceFile, member,
        `\`${name}\` is written outside meta; the kernel and this table read only meta.${name}, so it is ignored${name === 'devOnly' ? ' (the plugin would be bundled and installed in production)' : ''}`,
        `move it into meta: defineUiPlugin({ meta: { id: '…', ${name}: … }, apply })`,
      );
    }
  };
  misplaced(wrappers.flatMap((wrapper) => wrapper.properties));

  if (calls.length === 0) {
    const bare = unwrap(exported);
    if (ts.isObjectLiteralExpression(bare) && bare.properties.some((member) => memberName(member) === 'meta')) {
      fail(sourceFile, bare, 'the default export is a plain plugin object; official plugins are defined with defineUiPlugin', "wrap it: export default defineUiPlugin({ meta: { … }, order, apply(ctx) { … } }) (drop `name`, it defaults to meta.id)");
    }
    fail(sourceFile, exported, 'the default export contains no defineUiPlugin(…) call', CONVENTION);
  }
  if (calls.length > 1) {
    fail(sourceFile, calls[1], `the default export contains ${calls.length} defineUiPlugin(…) calls; exactly one of them is the plugin`, 'define paired halves as separate consts or inside apply (ctx.ui.pair), not in the default export');
  }

  const call = calls[0]!;
  const definition = call.arguments[0] && unwrap(call.arguments[0]);
  if (!definition || !ts.isObjectLiteralExpression(definition)) fail(sourceFile, call, 'defineUiPlugin(…) is not called with an object literal', CONVENTION);
  misplaced(definition.properties);
  for (const wrapper of wrappers) {
    const override = wrapper.properties.find((member) => memberName(member) === 'meta');
    if (override) fail(sourceFile, override, 'meta is set outside defineUiPlugin(…)', 'give meta only to defineUiPlugin; a wrapper may add `order`');
  }

  const metaMember = definition.properties.find((member) => memberName(member) === 'meta');
  const metaValue = metaMember && ts.isPropertyAssignment(metaMember) ? unwrap(metaMember.initializer) : undefined;
  if (!metaValue || !ts.isObjectLiteralExpression(metaValue)) {
    fail(
      sourceFile, metaMember ?? definition,
      metaMember ? 'meta is not an inline object literal; id, platforms and devOnly are read from source, so a variable, import, call or shorthand `meta` cannot be read' : 'defineUiPlugin({ … }) has no meta',
      "write it inline: defineUiPlugin({ meta: { id: 'dstu.ui.<name>', platforms: ['desktop'], devOnly: true }, apply })",
    );
  }
  for (const member of metaValue.properties) {
    if (ts.isPropertyAssignment(member) && memberName(member) !== undefined) continue;
    const found = ts.isSpreadAssignment(member) ? 'a spread' : ts.isShorthandPropertyAssignment(member) ? `the shorthand \`${member.name.text}\`` : 'a computed or method member';
    fail(sourceFile, member, `meta contains ${found}; every field must be written as \`name: value\``, "spell each field out, e.g. meta: { id: 'dstu.ui.<name>', devOnly: true }");
  }

  const idNode = findProperty(metaValue, 'id');
  const id = idNode && unwrap(idNode.initializer);
  if (!id || !ts.isStringLiteralLike(id)) fail(sourceFile, idNode ?? metaValue, 'meta.id must be a string literal', "meta: { id: 'dstu.ui.<name>' }");

  let platforms: UiPlatformKind[] | undefined;
  const platformsNode = findProperty(metaValue, 'platforms');
  if (platformsNode) {
    const list = unwrap(platformsNode.initializer);
    if (!ts.isArrayLiteralExpression(list) || !list.elements.every(ts.isStringLiteralLike)) {
      fail(sourceFile, platformsNode, 'meta.platforms of an official plugin must be an array of string literals', `platforms: [${UI_PLATFORMS.map((p) => `'${p}'`).join(', ')}] (a subset)`);
    }
    platforms = list.elements.map((element) => (element as ts.StringLiteralLike).text as UiPlatformKind);
    const unknown = platforms.filter((platform) => !(UI_PLATFORMS as readonly string[]).includes(platform));
    if (unknown.length) fail(sourceFile, platformsNode, `unknown platform ${JSON.stringify(unknown[0])} in meta.platforms`, `use ${UI_PLATFORMS.join(' | ')}`);
  }

  let devOnly = false;
  const devOnlyNode = findProperty(metaValue, 'devOnly');
  if (devOnlyNode) {
    const value = unwrap(devOnlyNode.initializer);
    if (value.kind === ts.SyntaxKind.TrueKeyword) devOnly = true;
    else if (value.kind !== ts.SyntaxKind.FalseKeyword) fail(sourceFile, devOnlyNode, 'meta.devOnly of an official plugin must be a boolean literal', 'devOnly: true (or omit it)');
  }

  let slots: string[] | undefined;
  const slotsNode = findProperty(metaValue, 'slots');
  if (slotsNode) {
    const list = unwrap(slotsNode.initializer);
    if (!ts.isArrayLiteralExpression(list) || !list.elements.every(ts.isStringLiteralLike)) {
      fail(sourceFile, slotsNode, 'meta.slots of an official plugin must be an array of string literals', "slots: ['<plugin>.<slot>']");
    }
    slots = list.elements.map((element) => (element as ts.StringLiteralLike).text);
  }

  return { file, id: id.text, platforms, devOnly, slots };
}

/** Every official plugin directory (`src/ui-plugins/official/<dir>/index.ts`), sorted. */
export function listOfficialPlugins(root: string): OfficialPluginDeclaration[] {
  const dir = path.join(root, 'src/ui-plugins/official');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'index.ts')))
    .map((entry) => `src/ui-plugins/official/${entry.name}/index.ts`)
    .sort()
    .map((file) => readOfficialPluginDeclaration(file, fs.readFileSync(path.join(root, file), 'utf8')));
}

export function targetPlatform(value: string | undefined): UiPlatformKind {
  const platform = value || 'desktop';
  if (!(UI_PLATFORMS as readonly string[]).includes(platform)) {
    throw new OfficialPluginTableError(`VITE_DS_PLATFORM=${JSON.stringify(value)} is not a platform (expected ${UI_PLATFORMS.join(' | ')})`);
  }
  return platform as UiPlatformKind;
}

export interface OfficialPluginSelection {
  platform: UiPlatformKind;
  production: boolean;
}

export function selectOfficialPlugins(plugins: readonly OfficialPluginDeclaration[], { platform, production }: OfficialPluginSelection) {
  const included: OfficialPluginDeclaration[] = [];
  const excluded: { plugin: OfficialPluginDeclaration; reason: 'platform' | 'build' }[] = [];
  for (const plugin of plugins) {
    if (plugin.platforms && !plugin.platforms.includes(platform)) excluded.push({ plugin, reason: 'platform' });
    else if (plugin.devOnly && production) excluded.push({ plugin, reason: 'build' });
    else included.push(plugin);
  }
  return { included, excluded };
}

/**
 * Source of the virtual module: the same exports as `plugins.ts`, with static imports of the included plugins. Each
 * excluded plugin becomes a stub carrying only the meta fields the kernel skips it by (`platforms`, `devOnly`) and its
 * `slots`, so the kernel still records it as skipped — a plugin requiring it is skipped instead of failing, and
 * contributions to its slots are dropped instead of throwing "slot is not declared".
 */
export function renderOfficialPluginsModule(
  root: string,
  plugins: readonly OfficialPluginDeclaration[],
  excluded: readonly OfficialPluginDeclaration[] = [],
): string {
  const imports = plugins.map((plugin, i) => `import plugin${i} from ${JSON.stringify(path.join(root, plugin.file).split(path.sep).join('/'))};`);
  const stubs = excluded.map(({ id, platforms, devOnly, slots }) => {
    const meta = { id, ...(platforms && { platforms }), ...(devOnly && { devOnly }), ...(slots && { slots }) };
    return `{ name: ${JSON.stringify(id)}, meta: ${JSON.stringify(meta)}, apply() {} }`;
  });
  return `${imports.join('\n')}\nexport const officialUiPlugins = [${plugins.map((_, i) => `plugin${i}`).join(', ')}];\n`
    + `export const excludedOfficialUiPlugins = [${stubs.join(', ')}];\n`;
}
