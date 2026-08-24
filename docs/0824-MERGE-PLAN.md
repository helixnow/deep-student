# 0824 近期改造统一合并计划

日期：2026-08-24  
最终分支：`cursor/0824-cde6`（对外简称 0824）  
基准：`origin/main` @ `0e4c9fad`

本轮目标：把近 2–3 天的 PR/分支先收成几个主题仓，修复冲突并保证前后端编译，再归并到本分支。CI 暂不作为门禁。

## 1. 现状结论（第一轮 10 代理盘点）

- 开放 PR 约 115 个；8/21 之后 **main 零合并**。
- 近 3 天远程分支约 243 个；其中约 132 个无独立 PR，绝大多数是巨型 PR 的卫星工作枝。
- 真正有独特产品价值、必须作为主题仓底座的是这 8 个 tip（互相都不是祖先）：

| 主题仓 | 底座分支 | PR | 已吸收 |
|---|---|---|---|
| A wrapup | `cursor/sota-wrapup-0b49` | #268 | ~85 个小 PR（几乎全部 i18n/a11y/模型/流式修补） |
| B cloud-sync | `cursor/cloud-sync-sota-b343` | #177 | 83/86 卫星 |
| C generative-ui | `Generative-UI-0824` | #214 | 18/19 卫星（print-forced-colors 已被超集取代） |
| D anki | `cursor/anki-ai-native-research-bfca` | #215 | 产品代码，不是纯调研 |
| E optimization | `cursor/optimization0824-5575` | #213 | wi11 / r4-dep-sweep |
| F subapp | `cursor/sota-subapp-polish-2399` | #176 | w3/w4/w6/w8/w9/wave2/finder/reader 等 |
| G mobile | `cursor/mobile-uiux-unify-0888` | #172 | 移动端 90 轮 |
| H cache | `cursor/sota-p0-cache-telemetry-6117` | #183 | 叠在 #175 文档枝上 |

## 2. 明确忽略

- 全部 `dependabot/*`、release-please、`cla-signatures`、`master`
- 已关闭未合并 #101/#102/#103
- 过旧冲突 PR：#113、#123、#134、#155
- 已被 mega 吸收的卫星与小 PR（#165–#267 中除下列「剩余独特」外）
- #170 mythos-5（#268 判定为虚构模型）
- #198 把图片入口改成 200MB（与现行「文件 200MB / 图片 50MB」冲突）
- #200 旧 token 剥离（已被 #268 的 `model_special_tokens.rs` 取代）
- 已在 main 的旧枝：`os`、`nightly`、多数 `codex/*`、hotfix/fix-release 等

## 3. 仍需并入主题仓的剩余独特提交

- A wrapup：`d15d9ff6`（#164 finderStore hostId 分桶）；#159 中 ResourceIcons 暗色 token / ErrorBoundary 真重试（若 #268 未含）
- B cloud-sync：#169 FTP 550 tombstone、#174 WebDAV/S3 端点；可选移植 `r02-sync-more-tests`
- D anki：`cursor/occlusion-preview-interaction-rebased-c207` 的 `6c401455`；移植 #268 对 #187 的最终 token 语义
- F subapp：#160/#161/#162/#163/#167 中未被 #176 吸收的能力（按文件移植，不要整 PR 硬并）
- H cache：先合 #175 再合 #183
- 测试契约（可后置）：#205/#208/#209/#210（#203 与 #209 冲突，弃 #203）

## 4. 主题仓目标分支

| 主题仓 | 目标分支 |
|---|---|
| A | `cursor/0824-theme-wrapup-cde6` |
| B | `cursor/0824-theme-cloud-cde6` |
| C | `cursor/0824-theme-genui-cde6` |
| D | `cursor/0824-theme-anki-cde6` |
| E | `cursor/0824-theme-opt-cde6` |
| F | `cursor/0824-theme-subapp-cde6` |
| G | `cursor/0824-theme-mobile-cde6` |
| H | `cursor/0824-theme-cache-cde6` |
| 统一 | `cursor/0824-cde6` |

## 5. 推荐最终合成顺序

1. E optimization（结构基线，独占构建配置，对其它仓冲突少）
2. C generative-ui（加法式，与多数仓 CLEAN）
3. H cache（与 #268 CLEAN；与 #213 仅 lock/pipeline 语义）
4. A wrapup
5. B cloud-sync（与 A 在 ftp/s3/webdav 需语义合并）
6. D anki（与 A 在 `streaming_anki_service.rs` 冲突）
7. F subapp
8. G mobile（最后；与 F/A 冲突最多，按「主体用 F/A，重放 G 热区增量」）

## 6. 编译门禁（本阶段唯一硬条件）

```bash
npm ci
npm run typecheck
npx vite build
cargo check --manifest-path src-tauri/Cargo.toml --lib
```

不要因为 CI 红而停。lockfile/NOTICES 冲突时按主题仓规则重生成，不要手改乱锁。

## 7. 冲突处理原则

- 云存储：#177 为大改写，#268/#169/#174 为针对性修复；合 B 时先保证 #177 完整，再移植 #169/#174 的行为。
- 附件上限：文件 200MB，图片 50MB。拒绝 #198。
- 测试：#268 修了根因的，以 #268 断言为准；#176/#172 的产品改动不要用旧测试覆盖掉。
- `useMessageActions.ts`：#176 删除 vs #268 修改，保留产品能力后迁到 #176 新结构。
- legacy notes：#172 删除，#176 若只改了其中小补丁可弃补丁、跟删除。
- package-lock / THIRD_PARTY_NOTICES：合并后用项目脚本重生成。
