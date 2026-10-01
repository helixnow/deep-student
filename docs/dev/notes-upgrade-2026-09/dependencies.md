# WP04 — Milkdown 7.22.1 依赖升级与验证

日期：2026-09-21。基线 HEAD：`c7248a222191eef28b5f175d4a7217289594240e`；应用版本保持 `0.9.63`。环境：Node `v26.5.0`、npm `11.17.0`、macOS arm64。

**结果：整组 Milkdown 已从 7.21.3 升至 7.22.1，注册表版本与 MIT 已核实；direct、overrides、锁文件和已安装版本一致。许可证生成／检查、版本树、ProseMirror 单实例检查与 48 项定向 smoke 通过。桌面行为验收尚未完成。**

## 1. 独立改动清单与并发边界

| 本 WP 文件 | 改动 |
|---|---|
| `package.json` | 仅 6 个 Milkdown direct 和 core/ctx 两个 overrides 的版本号变化；其他字段、依赖范围与 PM overrides 保持基线 |
| `package-lock.json` | 6 个根依赖声明、24 个 Milkdown 包升级；保留上游新约束所必需的嵌套传递依赖，详见下表 |
| `legal/THIRD_PARTY_NOTICES.txt` | 由既有脚本生成：Milkdown／传递依赖清单及 lock 校验值更新，组件数 2009 → 2011，许可证正文仍为 848 份 |
| `docs/dev/notes-upgrade-2026-09/dependencies.md` | 本记录 |

以上四个文件构成 WP04 独立交付。**依赖升级与 schema／产品行为改动分开审阅**：本 WP 不编辑 `src/`、`src-tauri/`、测试、迁移、其他 WP 文档，也不把共享区其他 agent 的改动计入本 WP。上游依赖本身包含行为变化，见第 5 节，不能把“本 WP 无生产源码修改”解读成运行时行为必然完全不变。

开工时共享区已有 Crepe、toggle、搜索、AI review、全文模型等未提交修改；收尾时其他会话继续写入前后端文件。未执行 commit、stash、reset、checkout、clean、开分支或 worktree。手动编辑使用 `apply_patch`；锁文件由 npm install 生成，随后用 `apply_patch` 精确撤回本次 npm 产生的非必要依赖更新，再通过 npm install 同步安装结果。没有还原其他 agent 文件。

## 2. 注册表证据与前后版本

配置注册表及核验源均为 `https://registry.npmjs.org/`。升级前先查询 core，再对锁文件中的 Milkdown 包逐项查询；收尾按最后一个 `node_modules/` 后的真实包名精确筛选全部 24 个包复核，避免把嵌套 KaTeX 误当成 Milkdown 包。

逐包命令：

```sh
npm config get registry
npm view @milkdown/core@7.22.1 version license --json --registry=https://registry.npmjs.org
# 对下列 24 个包分别执行同样的 npm view <包名>@7.22.1 查询
```

core 返回 `{"version":"7.22.1","license":"MIT"}`；其余 23 个包也逐项返回 7.22.1 / MIT。24 项复核全部通过，没有目标 Milkdown 版本缺失，故无需执行“保留 7.21.3”的阻塞分支。注册表 tarball URL 与 integrity 使用 npm 生成值，没有手写版本发布元数据。

下表包名统一加 `@milkdown/` 前缀；每行升级前后均已比对 lock／installed，目标许可证均为 MIT。

| 组别 | 包名 | 升级前 | 升级后 |
|---|---|---|---|
| direct（6） | crepe、kit、plugin-automd、prose、transformer、utils | 7.21.3 | 7.22.1，精确固定 |
| overrides（2） | core、ctx | 7.21.3 | 7.22.1，精确固定 |
| 其余传递包（16） | components、exception、plugin-block、plugin-clipboard、plugin-cursor、plugin-diff、plugin-history、plugin-indent、plugin-listener、plugin-slash、plugin-streaming、plugin-tooltip、plugin-trailing、plugin-upload、preset-commonmark、preset-gfm | 7.21.3 | 7.22.1 |

### 必需的传递依赖变化

| 锁文件位置 | 升级前 | 升级后 | 原因 |
|---|---|---|---|
| `@milkdown/crepe/node_modules/katex` | 0.17.0 | 0.18.7 | Crepe 7.22.1 将要求从 `^0.17.0` 改成 `^0.18.0` |
| `@milkdown/crepe/node_modules/commander` | 无此嵌套项 | 15.0.0 | KaTeX 0.18.7 要求 `^15.0.0` |
| `@milkdown/components/node_modules/nanoid` | 无此嵌套项，使用根 5.1.11 | 6.0.1 | components 7.22.1 将要求从 `^5.0.9` 改成 `^6.0.0` |
| `@milkdown/utils/node_modules/nanoid` | 无此嵌套项，使用根 5.1.11 | 6.0.1 | utils 7.22.1 同样要求 `^6.0.0` |

表中路径均位于 `node_modules/` 下。新依赖均为 MIT。项目直接声明的 `katex: ^0.16.0`、`nanoid: ^5.0.7` 及根安装版本 0.16.47／5.1.11 保持原样；没有为强压旧传递依赖新增 overrides。NanoID 6.0.1 的 Node 要求为 `^22 || ^24 || >=26`，Commander 15 要求 `>=22.12.0`；本机 Node 26.5.0 满足，当前 CI workflow 使用 Node 22 主版本，具体 CI 安装与构建仍待流水线验证。

首次 `npm install --ignore-scripts --no-audit --no-fund` 顺带更新了 22 个可继续使用旧版的包项（Vue 及其内部包、Babel parser/types、PostCSS 及其 NanoID、`@ocavue/utils`、`@types/lodash`、部分 PM）。这些附带更新已逐项撤回本次差异，再执行同一 install 命令同步 node_modules。最终结构化对比确认：除根 Milkdown 声明及 `node_modules/@milkdown/` 子树，所有锁文件包项与基线深度相等；manifest 恰好只有 8 个 Milkdown 版本值变化。

## 3. ProseMirror 单实例

升级前、升级后的 `npm ls --all` 均正常退出，无 invalid／missing 依赖。最终 Milkdown 24 包统一 7.22.1；PM 16 个包各只有一个锁文件安装路径，且全部保持原版本：

| 包（统一 `prosemirror-` 前缀） | 前后版本 |
|---|---|
| model | 1.25.7 |
| state | 1.4.4 |
| view | 1.41.8 |
| transform | 1.12.0 |
| commands | 1.7.1 |
| keymap | 1.2.3 |
| schema-list | 1.5.1 |
| inputrules | 1.5.1 |
| history | 1.5.0 |
| dropcursor | 1.8.2 |
| gapcursor | 1.4.1 |
| tables | 1.8.5 |
| changeset | 2.4.1 |
| drop-indicator | 0.1.4 |
| safari-ime-span | 1.0.2 |
| virtual-cursor | 0.4.2 |

额外使用 `node --experimental-import-meta-resolve --input-type=module`，从锁文件中每个声明 PM 依赖的安装包位置执行 ESM resolve 并比较 realpath：16 个 PM 包各解析到唯一的根 `node_modules/prosemirror-*/dist/index.js`。使用 ESM 是因为部分 PM 辅助包只有 import 导出，不能用 CJS `require.resolve` 判定它们缺失。

运行时还严格比较以下 10 个导出身份：`Node`、`Schema`、`Fragment`、`EditorState`、`Plugin`、`TextSelection`、`EditorView`、`Decoration`、`Transform`、`Step`。直接 `prosemirror-*`、`@milkdown/prose/*`、`@milkdown/kit/prose/*` 三种导入结果逐个 `===`，均通过。该结果证明当前 Node ESM 模块图的同一性；生产 Vite bundle 的最终模块拓扑不在本次验收范围。

## 4. 已执行验证

| 检查 | 结果 |
|---|---|
| 官方注册表逐包 version／license | 24/24，7.22.1 / MIT |
| manifest／lock／installed 与变更范围 | 通过；8 个声明版本变化，所有非 Milkdown 子树锁项保持基线 |
| `npm ls --all`，显式传入所有 Milkdown／PM 包名 | exit 0；core/ctx overridden，其余重复引用均 deduped |
| PM ESM 路径与导出身份 | 16 个单路径；10 个核心导出三种入口严格同一 |
| `npm run licenses:generate` | exit 0；生成 2011 components |
| `npm run licenses:check` | exit 0；`[license-compliance] OK` |
| 定向 Vitest | 4 文件、48 tests 通过；19:22:23 开始，8.00s |
| 本 WP 跟踪文件 `git diff --check` | 通过 |

定向测试命令：

```sh
./node_modules/.bin/vitest run \
  src/components/crepe/plugins/__tests__/fullStackCreate.test.ts \
  src/components/crepe/plugins/callout/__tests__/callout.test.ts \
  src/components/crepe/plugins/wikilink/__tests__/roundtrip.test.ts \
  src/components/crepe/plugins/pasteLink/__tests__/pasteLinkPlugin.test.ts \
  --maxWorkers=1 --minWorkers=1
```

覆盖真实 Crepe 默认插件栈 create/destroy（1）、callout（15）、wikilink 往返（14）、pasteLink（18）。没有新增或修改测试。这些是 jsdom 下既有测试，在共享工作树当时状态运行，不代表其他 WP 之后修改的最终树通过。

未执行全仓测试、全仓 typecheck、生产构建、真实桌面验收或 Rust 测试。许可证生成脚本内部运行的是只读 `cargo metadata --locked --offline`。后续视觉与交互验收须用 `npm run tauri dev`，不得打开 demo/hero 页面替代。

## 5. 上游补丁保留与行为待验证

上游证据：[v7.22.1 release](https://github.com/Milkdown/milkdown/releases/tag/v7.22.1)（API 返回 published_at：`2026-08-12T12:22:05Z`）、[该 tag 的 kit CHANGELOG](https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/kit/CHANGELOG.md)。以下为上游发布说明确认的变更；**随依赖升级保留，不能据此宣布本应用行为已验收**。

| 上游变更 | 本 WP 状态／后续验证 |
|---|---|
| 7.22.0 `extendSchema` 注册顺序 #2429／#2370 | 保留；完整插件栈创建 smoke 通过。自定义 schema 顺序及 F01–F08 的完整往返仍待 schema WP 验证 |
| 7.22.0 list spread boolean #2423、列表选区 #2422／#2412 | 保留；嵌套列表、任务列表、序列化空行、移动端光标需后续验证 |
| 7.22.0 mark 输入规则锚定光标 #2433；7.22.1 inline code non-inclusive #2451／输入规则 #2445 | 保留；已有 pasteLink 测试通过，不等同于覆盖全部上游规则。行内代码边界、代码内粗斜体输入与多段粘贴待专项验收 |
| 7.22.0 slash root/floating options #2426、block options 透传 #2427 | 保留；不在依赖升级中切换宿主配置。桌面面板缩放／滚动后的菜单定位待验证 |
| 7.22.0 latex tooltip 响应更新 #2425、内部 input 唯一 id #2424 | 保留；多编辑器／公式编辑及此次 KaTeX 0.18.7 的渲染需真实桌面验证 |
| 7.22.0 table/prism 逐键性能 #2436、代码语言重高亮 #2440 | 保留；不计入应用性能改进结论，长表格与代码块实测待性能 WP |
| 7.22.1 只读代码块更新 #2455 | 保留；阅读模式切换与外部更新待验证 |
| 7.22.1 block handle 保留 `view.dragging` 节点 #2452 | 保留；Tauri 自定义 pointer 拖拽不能因此直接删掉，需桌面实际拖拽验证 |

应用侧现有适配／补丁也保持，不进行“升级顺便删补丁”：

| 位置／适配 | 保留理由与待验证项 |
|---|---|
| `CrepeEditor.tsx`：updateState 监听、序列化防抖、IME 合成态暂停、零宽占位／清理、销毁后 context 保护 | 上游发布说明不足以证明覆盖应用的 WebView 与保存时序。中文输入、空段落、撤销／重做、切页销毁、无污染保存待验证 |
| `hooks/useCrepeBlockDrag.ts`：Tauri pointer 拖拽 | 本地替代原生 HTML5 拖拽；上游 #2452 不证明 WebView 原生拖拽已可用，保留 |
| `features/imageUpload.ts` 与共享区在途 `uploadLifecycle.ts` | Tauri dialog、资源路径与异步上传生命周期是应用接线；保留并由上传 WP 验证，本 WP 不计入其成果 |
| `hooks/useSlashMenuCustomScrollbar.ts`、Crepe CSS／浮层接线 | 上游新配置能力不自动替代本地滚动与布局处理；定位与滚动待桌面验证 |
| `features/mermaidPreview.ts` | 自定义预览、主题与清洗路径保留；不因上游 code-block 修复而直接移除 |
| callout／toggle／wikilink 等 schema、输入规则与序列化 | 由独立 schema／行为 WP 审阅；本 WP 只提供升级后 smoke，不混入格式迁移 |

未发现 Milkdown 的 `patch-package` 安装脚本或专用补丁文件；这里的“保留”包括依赖包携带的上游补丁与应用层适配，未新建第三方源码补丁。

## 6. 移交主 agent

**共享 `node_modules` 已实际更新**：执行了两次增量 npm install（第一次升级，第二次将无关包恢复为原锁定版本），没有执行 npm ci 清空安装目录。最终安装已完成，可以基于 7.22.1 启动新的测试。安装期间已经运行的 watch／Vite／Vitest 进程可能保留旧模块或缓存；主 agent 应协调相关会话重新启动它们的测试或开发进程。本 WP 未终止其他进程。

许可证产物与锁文件必须随本 WP 一起交付；未来若另一个 WP 修改 Cargo.lock／package-lock.json，应重新生成许可产物。后续 schema、IME、拖拽、长文性能等结果请单独记录，不能以本次版本树／48 项 smoke 代替完整行为验收。
