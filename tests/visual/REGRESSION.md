# FE-A1 回归安全网：五层“效果不变”检查

`plans/FRONTEND-PLUGINIZATION.md` §2.8 的实现。FE-B 及以后的每个前端工作包，改造前后都用它证明“效果不变”。
F1 纪律照旧：先在改造前的提交上跑通，再改造；**不得为了通过检查而改基线**。

## 1. 五层一览

| 层 | 检查什么 | 命令（默认就是 `--check`） | 基线 | 平台 |
|---|---|---|---|---|
| 1 槽位快照 | UI 内核全部槽位的条目：id、key、order、owner、origin、值的投影（文案键、图标名、壳层元数据……），以及官方消费方算出的可见性；16 个场景（桌面/移动 × 开发/生产 × 普通/演示壳 × UI Lab 开/关） | `node scripts/plugins/slot-snapshot.mjs` | `__golden__/slots/<场景>.json`，`owner-moves.json` | 通用 |
| 2 DOM golden | 17 个场景（截图矩阵的 12 个，加上 research-memory、paper-search、media、productivity、data-sync）× 桌面 1440×900 / 移动 390×844 的结构化 DOM（标签、排序后的 class、语义属性、文本、open shadow root） | `node tests/visual/dom-golden.mjs` | `__golden__/dom/<平台>/<场景>.<尺寸>.txt` | 按平台 |
| 3 IPC 轨迹 | 18 个场景（含 4 步脚本化交互）里前端发出的 invoke：`命令(排序后的参数键{嵌套键})`、`listen:/unlisten:/emit:<事件>` | `node scripts/plugins/ipc-trace.mjs` | `__golden__/ipc/<场景>.json`、`inventory.json` | 通用 |
| 4 截图 | 12 场景 × 2 尺寸 × 浅/深色 = 48 张，外加字体环境指纹 | `node tests/visual/screenshots.mjs` | `__screenshots__/<平台>/*.png` | 按平台 |
| 5 chunk 图 | 生产主构建的 Rollup chunk 表：入口静态闭包的成员和字节数、懒加载页面仍是独立 chunk | `node scripts/plugins/chunk-graph.mjs` | `__golden__/chunk-graph/main.json` | 通用 |

一次跑完五层：`bin/heavy node tests/visual/regress.mjs --build`（约 8–10 分钟；`--layers slots,ipc` 只跑部分层）。`regress.mjs` 另外还会跑：

- 第六层 `evidence`：迁移前取证套件，见 3.6。
- `motion`：减少动态效果的开销检查，见 3.7。
- 2–4 层之前的启动预检 `tests/visual/lib/boot-check.mjs`：检查 chunk 之间有没有静态导入环，以及 `demo.html` / `demo-app.html?app=chat` 能否挂载出 `#root`。演示壳启动失败时会写明原因，并跳过这三层，不会让每个场景都超时出整页差异。
- `--base REV`：列出 `REV..HEAD` 里提交信息标 `[待审]` 的提交及其文件，见第 6 节。

每个命令都支持 `--update`（重写基线）；2–4 层还支持 `--scenes a,b`、`--dist DIR`（换构建目录）、`--base URL`（指向已在运行的演示服务）、`--build`。

## 2. 前置：演示壳构建

2–4 层驱动的是**生产模式的演示壳**（`demo.html` / `demo-app.html`，`src/demo/mockIpc.ts` 提供内存后端），不是 dev server：

```bash
bin/heavy node tests/visual/lib/build.mjs demo     # → dist-demo/，约 1 分钟（8 GiB 堆）
```

构建在 8 GiB 堆的子进程里跑：Node 默认的约 4 GiB 堆在这些构建上会 OOM。命令行没带 `--max-old-space-size` 时，脚本会自动起子进程。

`tests/visual/lib/build.mjs` 原样使用 `vite.demo.config.ts` / `vite.config.ts`，只把 `src/version.ts` 换成固定内容的虚拟模块（否则 git hash 让每个提交的产物都不同）。**改了 `src/` 之后必须重新构建**再跑 2–4 层；第 5 层每次自己构建（`--dist` 可复用已有构建）。

## 3. 各层细节

### 1 槽位快照

- 实现：`src/ui-plugins/testing/slot-snapshot.ts`（采集与比较）、`slot-snapshot.test.ts`（golden 测试，普通 `vitest run` 里也会跑）。用生产安装器 `installOfficialUiPlugins` 装进无头内核，遍历 `kernel.slots.definitions()`，新声明的槽位自动纳入；经适配器（命令、聊天 block、工作台应用、i18n）登记的贡献也记录在 `adapters` 里。
- 可见性用真实的消费方函数计算：`shellNavigationItems`、`settingsNavigation`、App 的演示壳 `allowInDemo` 规则。
- 生产装配快照 `slot-snapshot.app.test.ts` → `app-assembly.json`：先导入聊天插件模块再跑真实的 `createAppUiKernel()`，因此晚安装的官方 UI 插件（如 `dstu.ui.chat`）和聊天 block / event / mode 注册表（槽位名 `registry:chat.*`，带 owner）也在网里。每次采集前 `vi.resetModules()`，相当于一次全新启动（主窗口内核和注册表是进程级单例）。
- 比较器只放行 `owner-moves.json` 登记过的两种漂移，伴随的任何其他变化（key、order、origin、value、消费方输出）照样失败：
  - owner 变化：`{ "slot": "nav", "id": "todo", "from": "dstu.ui.shell", "to": "dstu.todo" }`；`"id": "*"` 表示该槽位里所有原属 `from` 的条目整体迁移（FE-B2 那种“官方插件认领整张注册表”）。
  - 新增条目：`{ "slot": "chat.toolResults", "id": "<完整 id>", "from": null, "to": "dstu.ui.chat" }`，id 必须逐条列出，owner 必须一致。
  - 可选 `note` 字段写工作包与提交号，供审查。
- 失败输出是逐条的：`slot nav: sequence …`、`nav/media: order 30 → 20`、`consumers.nav[1].id: …`。

### 2 DOM golden

- 序列化器 `src/ui-plugins/testing/dom-snapshot.ts`：无依赖、只用可擦除的 TS，Node 可直接加载，同一份代码在页面里和 jsdom 里运行。丢弃 inline style（布局随字体变化）、SVG 内部、script/style；id 及其引用重编号为 `@1 @2…`；`data-*-owner-key` 末尾的模块级计数器（如 `sandbox:chat-page:<n>`，每次被丢弃的渲染也会加一）按前缀重编号为 `#1 #2…`；掩码时间戳、UUID、服务端口、实测耗时、OverlayScrollbars 的 auto-hide 计时 class。
- 场景：`scenes.mjs` 的 `DOM_SCENES`，即全部场景减去 `DOM_EXCLUDED`。第八轮把截图矩阵外的单应用场景也纳入（原来只有 IPC 的 boot 一步），golden 在改造前提交 `1d1fdb78` 上 `--update` 连录 3 次逐字节一致才提交。`reading-translation` 不纳入：桌面视图的 PDF 虚拟列表有时多渲染可见页之前的一行（第 42 页），3 次里出现 2 次。
- 组件级 golden（FE-B2 的 28 种 block、FE-B3 的工具卡片）直接在 vitest 里用：

  ```ts
  import { serializeDom } from '@/ui-plugins/testing/dom-snapshot';
  await expect(serializeDom(container)).toMatchFileSnapshot('./__golden__/ankiCards.done.dom.txt');
  ```

- 不一致时实际结果写到 `tests/visual/.out/dom/<平台>/`，并打印 diff。

### 3 IPC 轨迹

- 录制：页面初始化脚本包住 Tauri mock 装上的 `__TAURI_INTERNALS__.invoke`，只记命令名和参数键形状，不记值；`plugin:event|*` 记成事件名。
- 每个场景、每一步保存去重后按首次出现排序的调用。`--update` 每个场景跑 3 次：调用集合必须三次一致；只有三次的**命令**顺序都一致时该步才标 `"order": "sequence"`，否则标 `"set"`（懒加载 chunk 的到达顺序会让副作用竞争）。监听注册顺序和调用次数（防抖保存、轮询）不比较。
- 已知的竞争命令可以在 golden 的步骤里手工登记 `"unordered": ["命令(参数键)", …]`：这些命令只查有无，不参与任何顺序比较；`--update` 沿用被替换 golden 里的这份清单，判断 `sequence` 时同样排除它们，所以一条竞争命令不会把整步降成 `set`。登记要单独提交，并写明两边（改造前提交和当前提交）都出现竞争的证据。目前只有 `notes` 的 boot 登记了 `notes_editor_register(noteId)`。`regression-net.test.ts` 钉住了全部登记的精确清单，新增登记必须在同一个提交里改这条测试。
- `--check`：增删任何调用都失败；`sequence` 步的命令顺序变化也失败。失败的场景默认重试 1 次（`--retries 0` 关闭）。
- 启动计时器（只在本层）：页面时钟默认随墙钟走，启动时用 `setTimeout` 排的调用落在 boot 窗口里还是窗口外，原来取决于页面多快静下来。`scenes.mjs` 的 `BOOT_CLOCK` 给两个整壳场景加了固定的时钟推进，`ipc-trace` 以 `openScene(…, { clock: true })` 打开场景时执行：
  - `replyJump`（shell-chat）：boot 播放的回复发出第一个块的 `end` 后，`page.clock.fastForward(5000)` 一次，发生在等 DOM 静止之前（静止期间跳 5 秒会被当成 5 秒无变化）。流式块保存（`STREAMING_BLOCK_SAVE_THROTTLE_MS`，首个分块后 5 秒，流结束时取消）因此总在流结束前触发。
  - `startupTimers`（shell-chat、shell-desktop）：场景静止并 settle 之后 `page.clock.runFor(5000)`，再 settle 一次。boot 期间排下的 5 秒以内的计时器都落在 boot 里，包括启动 5 秒后的静默更新检查（`src/hooks/useAppUpdater.ts`）。
  - 为此轨迹行会带上聊天块事件的 `phase`（start/chunk/end），只供这里判断，golden 不读。DOM、截图和 motion 层不推进时钟，基线不受影响。
  - 推进会让之后每一步在页面时间上整体后移，周期计时器落在哪一步也随之改变（见第 9 节的提醒轮询）。所以 golden 必须带着推进录制，改动推进量要重录受影响的场景。
- `--throttle R`（只用于 `--check`）：用 CDP 给每个场景的页面降频 R 倍，用来证明轨迹不随机器快慢变化。基线不在降频下录制。
- `inventory.json` 是“调用形状 → 场景”的汇总，可直接喂给 W09 的 `frontend-invoke` 门禁。它完全由各场景 golden 推出：每次成功的 `--update`（包括 `--scenes`）都按磁盘上的全部 golden 重写它，自测保证它与 golden 一致。
- 交互脚本在 `tests/visual/lib/scenes.mjs` 的 `STEPS`（目前 shell-chat：打开会话、发送消息、命令面板、新建会话）。

### 4 截图

- Playwright Test：`tests/visual/playwright.visual.config.ts` + `screenshots.visual.ts`；`maxDiffPixelRatio: 0.001`，截图前等两次一致，`animations: 'disabled'`、隐藏光标。
- 报告（expected / actual / diff 三图）：`tests/visual/.out/screenshots-report/index.html`。
- 首个用例 `font environment` 比对字体指纹（四套字体栈的文字宽度），字体环境一变就明确失败，而不是 48 张图一起红。

### 5 chunk 图

- 主构建期间用内联 Rollup 插件记录 chunk 表（`.ds-chunks.json`），归一化为不含 hash 的图：chunk 以 facade 模块或 manualChunks 名标识，模块 id 相对仓库。
- `--check` 规则：① 入口静态闭包不得新增源模块（`src/ui-kernel/`、`src/ui-sdk/` 除外）或依赖包；② 闭包字节数（chunk + 入口 CSS − 内核/SDK 模块）不得增长，确有理由时用 `--allow-growth N` 并在报告里写明；③ 基线里每个懒加载的 `src/` 模块仍是独立的动态 chunk，且不在入口闭包里（R6-06 的五个页面都在其中）。
- 其余结构变化（模块换 chunk、字节变化）只列出；`--strict` 让任何变化都失败（用于“构建两次零差异”）。
- 本层只看生产主构建。演示壳构建的 chunk 环由启动预检（`boot-check.mjs`）负责：W18 的 `ui-boot` 分组在演示壳构建里曾形成 `ui-boot ⇄ vendor-*` 静态环，导致白屏，而生产构建当时没有环。

### 启动门禁（boot-check）

```bash
bin/heavy node tests/visual/lib/boot-check.mjs --build          # 在临时目录构建演示壳 → 扫 chunk 环 → 启动两个入口 → 删除构建
bin/heavy node tests/visual/lib/boot-check.mjs --build --main   # 另外构建生产主应用，只做静态环扫描（index.html 需要 Electron）
node tests/visual/lib/boot-check.mjs [--dist DIR]               # 检查已有的演示壳构建（默认 dist-demo/）
node tests/visual/lib/boot-check.mjs --static --dist DIR        # 只扫环，不开浏览器
```

- 退出码：0 通过；1 有环或启动失败；2 用法错误或构建失败。`--keep` 保留临时构建（`tests/visual/.out/boot-check/`），`--json FILE` 输出结构化结果。
- 有环时，每个环打印三部分：
  - 最短回路，例如 `ui-boot → vendor-react → … → ui-boot`；
  - 每条边导入的绑定，例如 `vendor-react imports {b5 as Zt} from ui-boot`；
  - 回路上每个 chunk 里的源模块（含 `\0` 虚拟模块）。
- 启动失败时，打印 `#root` 为空的入口和页面报错。
- 模块清单来自构建时记录的 `.ds-chunks.json`，`lib/build.mjs` 对 demo 和 main 都会写。

### 6 迁移前取证套件（evidence）

- 位置：`src/ui-plugins/testing/__tests__/evidence/*.golden.test.tsx`，golden 在 `src/ui-plugins/testing/__golden__/evidence/`。命令：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts src/ui-plugins/testing/__tests__/evidence --maxWorkers=2`。
- 组件通过生产装配挂载（`harness.tsx` 的 `bootAppUi()` = `createAppUiKernel()` + `UiKernelProvider`），IPC 用 CT 的 Tauri mock，只记命令名和参数形状。
- 覆盖范围：

  | 套件 | golden | 内容 |
  |---|---|---|
  | 调试面板 | `debug-panels.*` | 插件清单、各面板 DOM |
  | 仪表盘 | `dashboard.*` | 桌面/移动 × 已加载/空/出错/加载中/嵌入的 DOM；图表刻度与路径；每个按钮的动作（导航、事件、IPC、store、下载、打开的对话框及其一级动作） |
  | 编辑器扩展 | `editor.*` | Crepe 功能配置；`editor.use` 顺序（50 条）；schema；ProseMirror 插件与按键探测矩阵；input rules；斜杠菜单与工具栏 DOM |
  | Finder 右键菜单 | `finder-menu.json` | 11 种条件 × 6 种目标，共 63 个用例；每个用例记录条目、禁用、危险标记和点击后的回调 |
  | 工作台菜单 | `workbench-menus.json` | 桌面、Dock、状态栏应用/窗口/品牌菜单；记录条目、快捷键、勾选、禁用和子菜单 |
  | 笔记树右键菜单 | `notes-tree-menu.<目标>.json` | 6 种目标：VFS 文件夹、嵌套文件夹、路径文件夹、笔记、收藏笔记、导图。记录条目，以及 Shift+F10 打开的条目是否相同；每个条目在全新挂载上点击，记录后端调用、事件、标签页与分屏、打开的对话框或行内面板及其后续操作（命名后回车、确认删除）、行内重命名 |

- i18n：每个套件都有 `vi.mock('react-i18next', () => import('./i18nMock'))`。命名空间与 CT 共用 mock 相同，只修了一处：`t(key, '后备文案')` 先查语言包，查不到才用后备文案。共用 mock 直接返回后备文案，所以工作台菜单里的应用名曾显示成 typeId。
- golden 只写一次：`W16_CAPTURE_GOLDEN=1` 时文件不存在才写，已有文件不覆盖。要更新，先删掉对应文件再采集，删除和重采单独提交。不一致时实际结果写到 `tests/visual/.out/evidence/`。
- 不一致时，断言消息里带着差异行（`harness.tsx` 的 `describeTextDiff`）：首个不同的行号、两边的行号范围、前后各 2 行上下文，最多 30 行。服务器的 JSON 报告只保留断言消息、不保留 vitest 的 diff，只在 Linux 上红的 golden 靠这段消息就能定位。
- W18/W19 迁移这些模块时，全部套件必须照旧通过。

### 7 减少动态效果的开销（motion）

```bash
node tests/visual/motion-check.mjs [--scenes notes] [--dist DIR] [--throttle R]
```

- 背景（W26）：`src/shared/styles/deep-student.css` 在 reduce 下给所有元素强制 `transition-duration: 0.01ms`（保留 `transitionend`）。`transition-property` 的初始值是 `all`，没有 `src/styles/ui-motion.css` 里分层的 `transition-property: none` 默认值时，每个元素都变成 `transition: all 0.01ms`。notes 加载期间 reduce 下会新建几千个过渡，no-preference 下只有 7 个，样式重算慢十几倍。
- 做法：同一个构建、同一套固定环境（`lib/page.mjs`），只换 `reducedMotion`，各跑一次。初始化脚本在 document 上以捕获阶段统计 `transitionrun`，在场景执行 `window.__DEMO_READY__ = true` 的那一刻读数。窗口终点是同一个应用状态，与机器快慢无关；不比较任何耗时。
- 通过条件（每个场景）：
  - reduce 的次数不多于 no-preference；
  - `matchMedia` 报告的模式与请求一致；
  - 一个声明了过渡的探针元素在两种模式下都触发 `transitionrun` 和 `transitionend`。这一条证明计数器有效，也守住「声明过的过渡在 reduce 下照样派发事件」。
- 失败时打印 reduce 下按属性、按元素统计的前 5 名，便于定位是哪条样式放出了过渡。
- 默认只跑 `notes`（问题最初在这里暴露）；`--scenes` 只接受带 `__DEMO_READY__` 的单应用场景。没有基线，不支持 `--update`。`--throttle R` 用 CDP 降频，用来证明计数不随机器快慢变化。
- 在 Linux 上随 `run-native.sh check` / `run-docker.sh check` 一起跑。

## 4. 稳定性措施（2–4 层共用，`tests/visual/lib/page.mjs`）

应用层环境在所有主机上一致：macOS 桌面 UA 与 `navigator.platform`、zh-CN、Asia/Shanghai、Playwright 时钟固定起点（时间照常流动，避免防抖类逻辑卡死）、`Math.random` / `crypto.getRandomValues` / `randomUUID` 固定种子、`prefers-reduced-motion`、deviceScaleFactor 1、外网请求全部拦截。就绪判据：单应用演示等 `window.__DEMO_READY__`，整壳演示等剧本首答播完后 DOM 静止 2.5 秒；之后统一等字体、图片、两帧和 0.8 秒无 DOM 变动。

只有栅格化（字体、抗锯齿）依赖主机，所以截图和 DOM 按平台存放；IPC、槽位、chunk 图跨平台共用。

## 5. Linux 基线（规范平台）

方案要求截图基线在 Linux 上生成。

**现状**（INT `1fcc7743`）：11 个场景的 Linux 基线已提交，是服务器在 `560d7169` 上生成的，共 22 份 DOM、44 张截图和 `font-environment.json`。

- 缺 `notes` 场景（2 份 DOM、4 张截图）：服务器上 notes 在 reduced motion 下要 27–50 秒才就绪，超过 `openScene` 的 30 秒上限。性能问题归 W26，超时不放宽。
- DOM 层与平台无关。把实测的「用时 N 秒」掩码后，22 份 linux DOM 与同一提交的 darwin DOM 逐字节相同；skills-mcp 的 RF-W09 也已同步。所以 darwin 上的 DOM `--check` 结论同样适用于 Linux。截图仍按平台存放。
- 因此，任何 lane 更新 darwin 的 DOM golden 时，要把同名文件复制到 `linux/`（notes 除外，Linux 上还没有），并在同一个提交里用 `cmp` 确认两边一致。例如 W19 的 `b38fb80b` 只改了 darwin，linux 由 W16 的 `6b3ef583` 补上。
- 第八轮新纳入 DOM 层的 5 个场景（10 份），linux 那份同样是 darwin 的 `cmp` 一致副本，还没在 Linux 上跑过：等服务器 `run-native.sh check` 确认；不一致就在同一提交上 `run-native.sh update --scenes <场景>`，只提交 `dom/linux` 里的那几份。
- 补 notes 的办法：W26 修好后，在 INT 上先跑 darwin 的 `dom-golden.mjs --check --scenes notes --retries 0`。通过就说明 notes 的结构与改造前一致，这时在同一提交上执行 `tests/visual/linux/run-native.sh update --scenes notes`，并单独提交结果。

生成 Linux 基线：

```bash
# 有 Docker 的任意主机（推荐）：镜像固定 Playwright 1.60.0 + Noto 字体，node_modules 在容器卷里重新安装
tests/visual/linux/run-docker.sh update      # 写入 __golden__/dom/linux 与 __screenshots__/linux
tests/visual/linux/run-docker.sh check

# 已有 Linux node_modules 的主机（如构建服务器），经 bin/heavy：
tests/visual/linux/run-native.sh update
```

容器只读挂载仓库、在私有副本里构建，最后只把 linux 基线目录拷回；`check` 模式顺带在 Linux 上校验通用的 IPC 基线。Linux 基线也要在**改造前的提交**上生成并单独提交。

**服务器执行清单（主代理）**：

- **提交**：`560d7169`。这是 W16 第一轮的 tip，在 W17（`8d7292c2`）和 W18（`9818178e`）合入之前，树里已有 darwin 基线和 `run-native.sh`。不要在 `68d37526` 上跑：该提交的演示壳构建有 chunk 环，会白屏。
- **前置**：
  - 字体：`apt install fonts-noto-core fonts-noto-cjk`。
  - 依赖：Linux 版 node_modules，含 Playwright 1.60.0 的 chromium（`npx playwright install chromium`）。
  - `bin/heavy` 可选：没有时 `HEAVY=` 置空直接跑。
- **命令**：

  ```bash
  git worktree add wt/_linux-baseline 560d7169 && cd wt/_linux-baseline
  ln -s <linux node_modules> node_modules
  tests/visual/linux/run-native.sh update     # 演示壳构建约 2 分钟，DOM 约 2 分钟，截图约 4 分钟
  tests/visual/linux/run-native.sh check      # 再跑一遍确认稳定，并校验 IPC；约 8–10 分钟
  tar czf linux-baselines.tgz tests/visual/__golden__/dom/linux tests/visual/__screenshots__/linux
  ```

- **产物**：
  - `tests/visual/__golden__/dom/linux/`：12 场景 × 2 尺寸 = 24 份。
  - `tests/visual/__screenshots__/linux/`：48 张 PNG，外加 `font-environment.json`。
  - update 加 check 合计约 16–20 分钟。
- **收尾**：把 tgz 带回，在 W16 分支解包，`git add -f` 两个目录，单独提交。

## 6. 什么时候更新基线，怎么审查

- **等价重构（FE-B/C/D 的常态）：不更新。** 改造前后五层都必须通过；槽位层只允许 `owner-moves.json` 登记的 owner 变化，chunk 层只允许内核/SDK 增长。
- **有意的行为变化**（新功能、修 bug、文案调整）：在同一个工作包里单独一个提交更新基线，提交信息写原因，报告里贴各层 `--check` 的差异摘要；只更新受影响的层和场景（`--scenes`）。
- **`[待审]` 变化**（BRIEF §7：前端 lane 的用户可见改动单独提交，提交信息标 `[待审]`）：
  - `regress.mjs --base <改造前提交>` 会列出这些提交和它们改动的文件。
  - 某层的差异能由其中某个提交解释（同一组件、同一场景），就归为“待审的有意变化”，报告里单列，等审查通过后再更新基线。
  - 解释不了的一律按回归处理。
  - 已批准的 RF 登记（`host/e2e/differential/rust-fixes/RF-*.json`，`userVisible: true`）同样算有意变化，基线更新的提交信息里写明 RF id。
- **工具链变化**（Playwright/Chromium/字体/Node 升级）：只重生成截图（和必要时 DOM）基线，单独提交。
- **新增场景/交互步骤**：先在改造前提交上用 `--update --scenes <新场景>` 生成，单独提交。
- 审查方法：槽位与 IPC 看 `--check` 的逐条输出和 JSON diff；DOM 看 `git diff`（每行一个节点）；截图看 HTML 报告的三图；chunk 图看 `--check` 列出的闭包成员与字节变化。基线 diff 里出现与改动无关的区域，按回归处理。

## 7. 变异验证（证明各层有效）

```bash
bin/heavy node tests/visual/mutations/verify-mutations.mjs [--also-screenshots]
```

依次施加并自动还原三个变异：改导航顺序（槽位层必须报 `slot nav: sequence`）、改侧栏一处 class（DOM 层必须报出该行）、把一次 `chat_v2_list_sessions` 的 `groupId` 改成 `group_id`（IPC 层必须报 `+ chat_v2_list_sessions(group_id,…)`）。结果写到 `tests/visual/.out/mutations.json`。

## 8. 扩展

- 新场景：`tests/visual/lib/scenes.mjs` 的 `SCENES`；DOM 层默认纳入（快照不可复现的列进 `DOM_EXCLUDED` 并写明证据）；进截图矩阵的加入 `VISUAL`。
- 新交互：`STEPS[<场景>]` 加 `{ name, run(page) }`；每步的调用单独记录。
- 新槽位的可见性：在 `slot-snapshot.ts` 的 `consumerOutputs` 里调用该槽位的真实消费方函数。
- 新适配器注册表：在 `slot-snapshot.ts` 的 `adapters` 里加录制器。目前已录制 commands、chatBlocks、chatEvents、chatModes、workbenchApps、i18n。
- 新取证套件：在 `src/ui-plugins/testing/__tests__/evidence/` 加 `*.golden.test.tsx`，用 `harness.tsx` 的 `expectGolden`；`__tests__` 不在 Tailwind 扫描范围内。
- 注意：`src/**` 会被 Tailwind 扫描，测试辅助文件里不要出现类似工具类名的取反标识符（会多生成 CSS，第 5 层能抓到）。

## 9. 已知限制

- 演示壳里经典布局只开放对话视图（App 的 `allowInDemo`），其他页面通过单应用演示覆盖；设置分区内容由 `models` / `skills-mcp` 等场景覆盖一部分。
- 移动尺寸沿用官网移动端演示的做法（桌面 UA + 390 宽），不模拟触屏 UA。
- Linux 基线缺 `notes` 场景（等 W26），见第 5 节。本机 Docker 镜像存储损坏，Linux 上的 `check` 只能在服务器上用 `run-native.sh check` 跑。
- IPC `notes` 的 boot 步骤有一处竞争：`notes_editor_register`（编辑器挂载后）与技能加载链（`skill_list_directories` → `chat_v2_list_runtime_roots` → `super_session_get_state`）的先后不定，改造前的提交和 INT 上都约一半运行出现。已在 golden 里把它登记为 `unordered`（见 3.3），其余命令照旧检查顺序。
- 两处启动计时竞争已在第七轮用 3.3 的时钟推进处理（`80e93fc5`），产品代码、断言都没改，也没有把调用标成可选：
  - `shell-chat`：`chat_v2_upsert_streaming_block` 是流式块的防闪退保存，在第一个分块后节流 5 秒触发（`src/features/chat/core/constants.ts:35`）。演示的 anki-cards 流按剧本约 5.06 秒，原来保存与流结束只差 6–22 ms（`fe5feb68`），6 次里有 1 次没有保存。推进后保存比流结束早 4.7–4.9 秒。
  - `shell-desktop`：`plugin:updater|check()` 是启动后 5 秒的静默检查，原来 boot 窗口在 5062–5269 ms 结束，`fe5feb68` 上 5 次全部漏掉。推进后检查在 5.6–6.0 秒触发，窗口约 11.6–12.0 秒才结束。
  - 新网在 `fe5feb68` 的构建上连跑 3 次、在第七轮合并后的构建上连跑 5 次，两个场景都通过。证据和降频结果见 `W16-PROGRESS.md` 第七轮。
  - 为什么不用暂停的时钟：动画、打字机和流式剧本都靠页面计时器推进，暂停后每一步都得显式推进，DOM 和截图层看到的状态也会变。现在只在 IPC 层的 boot 末端推进两次，DOM、截图和 motion 的基线不受影响。
- 仍依赖页面时间的一处：`todo_list_reminders()` 来自提醒调度器 30 秒一次的轮询（`src/features/todo/reminderScheduler.ts:20`），不是哪一步触发的。shell-chat 的 `open-session` 这一步约 20 秒，第一次轮询落在演示自动打字期间：比最后一个加载命令 `llm_usage_session_summary` 晚 5.2 秒，比发送时的 `chat_v2_has_active_stream` 早 6.9 秒；4 倍降频下是 3.3 秒和 10.9 秒。推进之前的旧 golden 把它录在这一步最后，余量只有发送后 3.8 秒、步骤结束前 2.4 秒。改变 boot 时长或 `open-session` 的打字长度，都可能让它换位置；遇到这条顺序差异，先看轮询时刻，不要当成产品回归。
- DOM `shell-desktop`（desktop 或 mobile）偶发：5 个桌面快捷方式 `data-wb-desk-shortcut="shortcut_<ts>_xxxxxxx"` 的随机后缀整体前移 4 位，其余内容不变。
  - 机制：后缀来自 `desktopStore.ts:220` 的 `Math.random()`。`page.mjs` 给全页只有一条固定种子的随机序列。快捷方式由懒加载的 `WorkbenchDesktop` 挂载时创建（`DesktopShortcuts.tsx` 的 `initDefaultShortcuts`），平时排在另一个启动时抽 4 个随机数的消费者之后；chunk 晚到时次序反过来。
  - 第七轮合并后的构建上，13 次启动里出现 2 次：两次都在完整的 `dom-golden` 运行里（多个页面并行，负载约 25），单独顺序启动 8 次一次都没有。
  - `--check` 默认重试 1 次，多数会被吸收。更新基线时要确认这 5 个后缀没变，变了就重录。
  - 没有处理：给后缀加掩码属于新增归一化，按派单规则不做；按调用点分流随机序列在压缩后的构建里不稳定。已交给主编排裁定，见进度文件第七轮。
- 取证套件只加载 11 个命名空间（与 CT 共用 mock 相同）。全量加载 47 个时，冷启动会超过 10 秒的 hook 超时。不在这 11 个里的键显示键名或后备文案。

## 10. 集成时怎么用（主代理）

**命令**。在要合入的提交上建一个临时 worktree，先合入回归网分支，再整套跑：

```bash
git worktree add -b verify/<WP> wt/_verify-<WP> <交付提交>      # 用交付提交，不用分支 tip
cd wt/_verify-<WP> && ln -s ../../deep-student/node_modules node_modules
git merge --no-ff assault/W16-fe-regression-net
bin/heavy node tests/visual/regress.mjs --build --base <改造前提交>   # 各层 --check + 启动预检 + [待审] 提交清单，末尾有汇总
bin/heavy node tests/visual/regress.mjs --layers dom,ipc        # 只复查某几层（复用已有 dist-demo）
bin/heavy node tests/visual/dom-golden.mjs --check --scenes shell-chat --retries 0   # 单层单场景复现
```

各层的实际结果在 `tests/visual/.out/`（DOM 文本、截图 HTML 报告）；chunk 层的结构变化直接打印在输出里。用完 `git worktree remove`，验证分支留着。

**判断差异**（逐条，不看总数）：

| 层 | 可以放行 | 必须追查 |
|---|---|---|
| 槽位 | 工作包声明的 owner 迁移、声明的新贡献 → 登记到 `owner-moves.json` | 任何 key / order / value / 消费方输出变化；未声明的增删 |
| DOM | 工作包声明的界面变化（同一处在截图里也应可见） | 与改动无关的场景里出现的变化；结构/属性变化 |
| IPC | 声明的命令改名或参数键修正（如 W09 的契约键） | 新增/消失的命令、`sequence` 步顺序变化 |
| 截图 | 与 DOM 差异对应的区域 | DOM 零差异却有截图差异（样式/CSS 回归） |
| chunk | `src/ui-kernel/`、`src/ui-sdk/` 增长；闭包内模块因压缩改名的几字节浮动 | 闭包新增非内核模块或依赖包、懒加载页面变成静态导入 |

先确认差异可复现：对失败的层用单层命令加 `--retries 0` 再跑两次。只在部分运行里出现、且基线提交上同样会出现的，是网的非确定性，交给 W16 修，不算工作包缺陷。

**登记预期差异**。在验证分支上改 `tests/visual/__golden__/slots/owner-moves.json`（格式见 3.1，每条带 `note`），重跑到通过；这个文件随工作包合入。其他层没有登记机制：DOM/IPC/截图的预期变化只能通过更新基线接受。

**什么时候允许更新基线**：

- 等价重构（FE-B/C/D）：不更新，只登记 owner 迁移/新增条目。
- 有意的行为变化：由**做出该变化的工作包**在自己分支上单独提交基线更新（`--update --scenes <受影响场景>`），提交信息写原因；集成分支上不更新基线，只出差异报告。
- 网本身的修正（掩码、采集范围）：只在 W16 分支，并在改造前的提交上证明零差异后再提交。
- 截图/DOM 的 Linux 基线由主代理在部署机上 `tests/visual/linux/run-native.sh update` 生成，单独提交。
