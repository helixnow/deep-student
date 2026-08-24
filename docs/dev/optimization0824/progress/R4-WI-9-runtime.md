# R4 WI-9 pdfjs 运行时化 + legal 去重（SA-R4-08）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R4-08
> 模型：`claude-fable-5-thinking-xhigh`
> 上游依据：`R1-static-assets-audit.md` §3.2（B1b legal 去重）、§3.3（C3 运行时化）；`R2-pdfjs-subset.md`（本地子集基线）

## 0. TL;DR

| 项 | 结果 |
| --- | --- |
| cMap/标准字体三级 fallback | ✅ `src/utils/pdfAssets.ts`：本地子集 → appData 缓存 → 远程（预留 URL 配置，默认关闭）+ 缺字日志 |
| worker 单一权威来源 | ✅ 删除 `public/pdf.worker.min.mjs`（git -1,046,214 B），viteStaticCopy 从 `node_modules/pdfjs-dist/build/` 拷贝，版本漂移不可能再发生 |
| R2 wasm/cmaps 裁剪巩固 | ✅ 白名单抽到 `config/pdfjs-local-assets.json` 单一清单 + 7 条守卫测试（防整目录回退、防 fallback JS 复活） |
| legal NOTICES 去重 | ✅ 唯一权威路径 `legal/THIRD_PARTY_NOTICES.txt`，只经 `bundle.resources` 进安装包；**dist −1,257,492 B，安装包内双份 → 单份** |
| licenses:check | ✅ 通过（含顺手修复 R4 并行提交漏再生成 NOTICES 的存量红灯） |
| vitest | ✅ 新增 19 例（CJK 真实链路 3 + fallback 单元 9 + 静态资产守卫 7），PDF 相关 30/30 通过；另修复设置页测试存量断点 mock 失败 |
| `npm run build` | ✅ 全流程通过，dist 产物逐项核对（§5） |

## 1. 三级 fallback（任务 1）

### 1.1 设计

R2 把 cmaps 裁到 68 个后，子集外资源（日/繁/韩遗留编码 cmap 等）此前是「告警 + 该字体空白」的硬降级。本轮把降级改成可恢复的运行时链路，`src/utils/pdfAssets.ts`：

1. **本地子集**（tier 1）：`fetch(cMapUrl/standardFontDataUrl + 文件名)`，即 dist 内 R2 白名单资源。带 `text/html` content-type 守卫，防 dev server / 网关 SPA fallback 用 200+HTML 顶替缺失文件。
2. **appData 缓存**（tier 2，仅 Tauri）：`@tauri-apps/plugin-fs` 读 `$APPDATA/pdfjs-assets/{cmaps,standard_fonts}/<文件名>`（capabilities 已有 `fs:allow-appdata-read/write-recursive`，零新增权限）。插件按需动态 import，纯 web 构建不拖入。
3. **远程**（tier 3）：命中后写回 tier 2 缓存（异步、失败不影响本次渲染）。目录布局镜像 pdfjs-dist 包（`<base>/cmaps/…`），基址锁版本即可直接用任何 npm 镜像。

**远程源默认关闭（预留 URL 配置）**：评估后没有可依赖的稳定 CDN——unpkg/jsdelivr 在大陆网络（本产品主用户群）可用性差且不受我们控制，硬编码会把「本地缺资源」变成「远程慢/断导致的加载抖动」。按任务预案落地为：本地子集 + 缺字日志 + 双通道预留配置：

- 构建期：`VITE_PDFJS_REMOTE_ASSET_BASE`（如自有 `download.deepstudent.cn` 镜像就绪后一行开启）
- 运行时：`localStorage["ds.pdfjs.remoteAssetBase"]`（优先级更高，预留给设置页/诊断工具）

**缺字日志**：三级全部落空才记录（`getMissingPdfAssetLog()`：kind + 文件名 + 依次尝试的来源 + 时间戳），同一资源仅告警一次，日志文案直接给出两个配置通道。此时 pdf.js 默认 `stopAtErrors:false` 下该字体走 ErrorFont，页面继续渲染，不 crash（有真实 pdfjs 测试背书，§4）。

### 1.2 pdf.js 接入方式

`pdfjs-dist@5.4.296` 未导出 factory 基类，按接口自实现 `FallbackCMapReaderFactory` / `FallbackStandardFontDataFactory`（构造签名、返回值与 `Base{CMapReader,StandardFontData}Factory` 一致），经 `PDF_OPTIONS` 传入 `getDocument`。已读源码确认（`build/pdf.mjs` L14084）：传入非 DOM 默认 factory 时 `useWorkerFetch` 自动为 false，cmap/字体请求经 worker `GetCMap`/`GetStandardFontData` 消息回主线程 factory——三级逻辑对 worker 透明；wasm 仍走 `DOMWasmFactory + wasmUrl` 主线程加载，路径语义不变。消费方 `EnhancedPdfViewer`（全仓唯一 `getDocument` 入口）零改动。

## 2. worker 单份确认 + wasm 裁剪巩固（任务 2）

### 2.1 worker：从「确认单份」升级到「结构性单份」

现状核对：WI-5 已删零引用的 `.js` 副本；全仓 `GlobalWorkerOptions.workerSrc` 赋值仅 `EnhancedPdfViewer.tsx:56` 一处，指向 wrapper。但 R1 §3.4 指出的隐患仍在——`public/pdf.worker.min.mjs` 是手工同步副本，升级 pdfjs-dist 会静默过期（API version mismatch）。本轮落地 R1 建议：

- `git rm public/pdf.worker.min.mjs`（仓库 −1,046,214 B）；
- viteStaticCopy 新增 target 从 `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` 拷入 dist 根（dev 由插件中间件同路径供给，已确认 `vite-plugin-static-copy@3.1.5` dev serve + mrmime 对 `.mjs` 给 JS MIME）；
- wrapper（`Promise.withResolvers` polyfill，旧 WebView 必需）保留在 public/，`import './pdf.worker.min.mjs'` 解析路径不变；
- 构建后 `cmp` 验证 dist 内 worker 与 node_modules 源逐字节一致。

守卫测试固化三个不变量：public/ 不允许再出现 `pdf.worker.min.*`；vite.config 必须存在 build/ 拷贝 target 且源文件存在；src/ 下 `workerSrc` 赋值有且只有 EnhancedPdfViewer 一处。

### 2.2 wasm/cmaps：单一清单 + 防回退守卫

- cmaps 白名单从 vite.config.ts 内联数组抽到 **`config/pdfjs-local-assets.json`**，vite.config 与全部三个测试文件消费同一清单，杜绝「配置改了测试还绿」。
- 守卫断言：wasm 拷贝必须是 `*.wasm + LICENSE*` glob（两 glob 均匹配不到 `openjpeg_nowasm_fallback.js`），禁止恢复 `{ src: wasmDir }` 整目录拷贝；白名单必须含简中 GB 全系与四 registry 的 `-UCS2`（ToUnicode 依赖），且 R2 裁掉的 `90ms-RKSJ-H`/`KSC-EUC-H`/`B5pc-H`/`ETen-B5-H` 不得回流（体积回归守卫）。

## 3. legal NOTICES 双份 → 单一权威路径（任务 3）

R1 §3.2 B1b 方案落地。改动链（一份文件、五个消费点）：

| 环节 | 改动 |
| --- | --- |
| 权威路径 | `git mv public/legal/THIRD_PARTY_NOTICES.txt legal/`（仓库根，与 LICENSE 并列；public/ 下不再有，故不进 dist） |
| 生成 | `generate-third-party-notices.mjs` 输出改 `legal/`；再生成幂等（连续两次 SHA-256 一致） |
| 合规校验 | `check-license-compliance.mjs`：`noticePath` 与 `requiredResources` 映射同步改 `../legal/…`，校验强度不变 |
| 安装包 | `tauri.conf.json` resources：`../legal/THIRD_PARTY_NOTICES.txt → licenses/THIRD_PARTY_NOTICES.txt`（合规硬需求保留） |
| 设置页 | Tauri 运行时 `resolveResource('licenses/THIRD_PARTY_NOTICES.txt') + readTextFile`（动态 import，capabilities 已有 `fs:allow-resource-read-recursive`，桌面+mobile 均在），失败回退 fetch；纯 web 仍 fetch |
| web dev | vite.config 新增 `legalNoticesDevPlugin`（apply:'serve'），按原 URL `/legal/THIRD_PARTY_NOTICES.txt` 代理权威文件，dev 体验零变化 |

`dist/legal/` 仅剩 34.5 KB 的 `DEEPSTUDENT_LICENSE.txt`（项目许可证，体量可忽略，仍走 fetch）。`docs/THIRD_PARTY_LICENSES.md` 的路径说明同步更新。

**边界说明**：Android 上 `resolveResource` + fs 读 resources 若在个别 WebView/打包形态下失败,组件回退 fetch → dist 无此文件 → 显示已有的「无法加载许可证文本」错误态,合规交付本身不受影响（APK 内 resources 副本仍在）。桌面三平台 resources 为真实目录,读取无此顾虑。

**顺手修复**：R4 并行提交 `bd145465`（tsgo 落地）改了 `package-lock.json` 未再生成 NOTICES，分支上 `licenses:check` 处于红灯。本轮 `npm ci` 同步后重新生成（diff 仅 lockfile SHA 一行），检查恢复绿灯。（VM cargo 1.83 过旧无法解析 edition2024 依赖，`rustup default stable`→1.98 后 `cargo fetch --locked` 通过，仅影响本机生成，不改仓库工具链要求。）

## 4. 测试（任务 4）

新增 19 例，全部通过；PDF 相关合计 30/30：

### 4.1 `tests/vitest/pdf/pdfCjkNoCrash.test.ts`（真实 pdfjs 链路，3 例）

不 mock pdf.js：真实 `pdfjs-dist` fake worker（jsdom 无 Worker → LoopbackPort 主线程跑 worker 代码，补最小 DOMMatrix shim），手工构造未内嵌字体的 Type0/CIDFontType0 PDF（程序化生成 xref），fetch stub 按 `config/pdfjs-local-assets.json` 白名单模拟 dist 子集：

1. **简中命中子集**：`UniGB-UCS2-H` 编码「中文」（`<4E2D6587>`）→ `getTextContent` 精确提取 `中文`（顺带覆盖 `Adobe-GB1-UCS2` ToUnicode 链路），缺字日志为空；
2. **子集外不崩溃**：`90ms-RKSJ-H`（R2 已裁）编码「日本語」、无远程源 → 文档正常打开、`getTextContent` 不抛错，缺字日志含 `90ms-RKSJ-H.bcmap`；
3. **tier 3 恢复**：配置远程源后同一 PDF 文本恢复提取为 `日本語`（`90ms-RKSJ-H` 走远程、`Adobe-Japan1-UCS2` 走本地子集，双通道同时验证），缺字日志为空。

### 4.2 `src/utils/__tests__/pdfAssets.test.ts`（单元，9 例）

三级顺序与短路、SPA-fallback HTML 守卫、远程命中写回缓存（mkdir+writeFile 参数级断言）、全落空抛错 + 缺字日志去重、路径穿越文件名拒绝、两个 factory 的 pdf.js 接口契约（`.bcmap` 拼接 / `{cMapData,isCompressed}` / 空参报错文案与基类一致）。

### 4.3 `tests/vitest/pdf/pdfStaticAssets.test.ts`（守卫，7 例）

§2 所列全部不变量。

### 4.4 存量修复：`tests/vitest/settings/OpenSourceAcknowledgementsSection.test.tsx`

- 更新第三方许可证用例为双路径：纯 web fetch 原断言保留；新增 Tauri 分支用例（stub `__TAURI_INTERNALS__` + mock `resolveResource`/`readTextFile`，断言读 `licenses/THIRD_PARTY_NOTICES.txt` 且不 fetch）。
- 顺手修复两个与本任务无关的存量失败：vitest.setup 的 matchMedia mock 恒 false 导致 P1-9 移动端分支上线后桌面 Dialog 用例必挂（按 1280px 视口模拟 min-width 查询）；DsDialog 的 `useDragControls` 缺 mock。

## 5. 验证与体积变化

```text
npm run licenses:check   # [license-compliance] OK
npm run typecheck        # 通过
npx vitest run <PDF 相关 6 文件>   # 30/30 通过
npm run build            # ✓ built in 1m 5s（EXIT:0）
```

dist 产物核对：`cmaps/` 68 个（623,393 B）、`wasm/` 6 个（350,331 B，无 fallback JS）、`standard_fonts/` 16 个（未动）、`legal/` 仅 DEEPSTUDENT_LICENSE.txt、worker 单份且与 node_modules 逐字节一致。

| 度量 | 变化 |
| --- | --- |
| dist（= frontendDist，进每个桌面安装包与 APK） | **−1,257,492 B（≈1.20 MiB）**：THIRD_PARTY_NOTICES.txt 不再进 dist |
| 安装包内 NOTICES | 双份（dist + resources）→ 单份（仅 resources），净省同上 |
| git 仓库 | **−1,046,214 B**：删除手工同步的 worker 副本（dist 内 worker 体积不变，改为构建期拷贝） |
| 运行时能力 | R2 裁掉的 101 个 cmap 从「永久空白」变为「可经缓存/远程恢复」，为后续 cmaps/standard_fonts 全量出包（再 −1.4 MiB，需远程源就绪）铺路 |

## 6. 风险与回滚

- **useWorkerFetch 关闭**：cmap/字体改经主线程消息转发，仅在「未内嵌字体的 CJK/标准 14 字体 PDF」首次装载时多一次 postMessage 往返（资源级、非页面级），实测无感；wasm 路径不变。
- **回滚**：`PDF_OPTIONS` 删去两个 factory 即回到 R2 行为；legal 去重回滚 = revert `git mv` + 五处路径改动。
- **后续（不在本轮）**：远程源就绪后把 `VITE_PDFJS_REMOTE_ASSET_BASE` 接入发布流水线，并评估 cmaps 全量出包；设置页暴露远程源/缺字日志诊断入口。
