// 用法（在 video/ 下）：node scripts/app-css.mjs
// 把主应用的全局样式（Tailwind + 设计 token + 旧全局样式）编译成一份样式表，选择器全部收进 .ds-app，
// 写到 src/app-ui/app.generated.css（不入库）。宣传片直接渲染主应用组件（src/app-ui）时用它。
// 依赖仓库根目录的 node_modules（tailwindcss / postcss / postcss-import / autoprefixer）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import scope from './app-css-scope.cjs';

const video = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(video, '..');
const out = path.join(video, 'src/app-ui/app.generated.css');

if (!fs.existsSync(path.join(repo, 'node_modules/tailwindcss/package.json'))) {
  console.error(`[app-css] 仓库根目录缺少 node_modules（${repo}）：先在仓库根目录安装主应用依赖。`);
  process.exit(1);
}
const req = createRequire(path.join(repo, 'package.json'));
const postcss = req('postcss');
const tailwind = req('tailwindcss');
const loadConfig = req('tailwindcss/loadConfig');
const atImport = req('postcss-import');
const autoprefixer = req('autoprefixer');

// 与 src/demo/app/main.tsx 的全局样式入口同序
const ENTRY = [
  'styles/tailwind.css',
  'styles/shadcn-variables.css',
  'styles/theme-colors.css',
  'shared/styles/index.css',
  'styles/typography.css',
  'styles/shadcn-overrides.css',
];

const abs = (glob) => (glob.startsWith('!') ? `!${path.resolve(repo, glob.slice(1))}` : path.resolve(repo, glob));
const base = loadConfig(path.join(repo, 'tailwind.config.js'));
const files = Array.isArray(base.content) ? base.content : base.content.files;
const config = { ...base, content: [...files.map(abs), path.join(video, 'src/app-ui/**/*.{ts,tsx}')] };

const source = ENTRY.map((f) => `@import ${JSON.stringify(path.join(repo, 'src', f))};`).join('\n');
const started = Date.now();
const result = await postcss([atImport(), tailwind(config), autoprefixer(), scope.scopePlugin()]).process(source, {
  from: path.join(video, 'src/app-ui/app.entry.css'),
  to: out,
  map: false,
});
for (const warning of result.warnings()) console.warn(`[app-css] ${warning.toString()}`);

let rules = 0;
result.root.walkRules(() => {
  rules += 1;
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `/* 由 scripts/app-css.mjs 生成，勿手改。来源：主应用 src/styles 与 src/shared/styles，选择器已收进 ${scope.SCOPE}。 */\n${result.css}\n`);
console.log(`[app-css] ${path.relative(video, out)}: ${(result.css.length / 1024).toFixed(0)} KB, ${rules} rules, ${Date.now() - started} ms`);
