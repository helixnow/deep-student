# 0824 leftover 审计（第八轮）

日期：2026-08-25

## 结论

- 重放目标：`origin/cursor/0824-cde6` @ `4f05d227`。该基线已含 A
  (`3efdc1b3`)、H (`e54603a0`)、B (`0e32e0fe`) 和 D (`a8185664`)。
- 来源：`origin/cursor/0824-leftovers-safe-cde6` @ `840eccb7`，其 24 个
  INCLUDE 代码提交原基线为 `af3e39d8`。24 个 patch-id 在新基线中均不存在，
  因此全部重放；没有把 F 已吸收的 #160/#161 六项重新带入。
- 分支仍为 `cursor/0824-leftovers-safe-cde6`。重放后相对 `4f05d227`：
  - H cache 链路文件零触碰；
  - A 的 vitest 四分片、`--logHeapUsage` 和 job 级 4096 MiB 配置保留；
  - B 的 cloud/sync 代码与 CI 修复保留；
  - D 的 flashcard-preview 仅展示语义保留：没有恢复
    `save-to-library` handler、文案或 locale key。
- 处置总计：**INCLUDE 24 / ALREADY 6 / DROP 9**。下表逐 SHA 记录，无未分类项。

## 完整 SHA 处置表（39 个）

### INCLUDE（24 个）

| 原 clean SHA | 第六轮 SHA | 第八轮 SHA | 处置 | 主题 |
|---|---|---|---|---|
| `10f1ad162fa5d14885753915fe635e75ef788d7b` | `77e2cb4f` | `4e0bb0e1` | INCLUDE | #213 技能契约与 qbank headless 禁令 |
| `b8cec84206f807d6a0b6dced1591da95144ccf98` | `94e3e26f` | `eb5279b4` | INCLUDE | matchMedia 测试设置 |
| `a10da59d948963b50b92a0c2f43cad867a598385` | `6d3500e9` | `814d0a28` | INCLUDE | note-edit 禁止 regex 转发 HITL |
| `6047ef94e5637d678fbbd090307c66d0d9050029` | `e392aa50` | `1bff7e7d` | INCLUDE | Rust noteEdit 256 KiB 上限 |
| `ef74bf726fbe762f0a6cc86b6781a381fc656d01` | `26a7b969` | `ec3fea5d` | INCLUDE | Rust noteEdit 字段白名单 |
| `703cf00a4257a38dbf8c03c5108fff3dbec28f8c` | `72de6bbf` | `eae6f682` | INCLUDE | TS/Rust researchSessionId 清洗 |
| `be793515b03cba6f6d5f83ff5adbe195e700724a` | `abb656f2` | `ed71df1b` | INCLUDE | 拒绝超 256 KiB 完整 intent |
| `ba64fda19d765f2d011fc1be2d101f82d2f2d3c3` | `9dfb6223` | `99740c0b` | INCLUDE | stream-cap 错误分类 |
| `3422f2120729f40bbffe74f6fda72808a1fa8b48` | `6f52111a` | `50f065aa` | INCLUDE | Rust/lint/vitest 修复 |
| `74444f6b1f5043b453315cb780a43ada18d7618b` | `9fa90281` | `fa6fb8cd` | INCLUDE | sessionId 契约与 sanitizer |
| `d71366980f19c1b7aeebd3e927aab93c5511f7bf` | `18ba5687` | `2fb56ffb` | INCLUDE | HPIAS session 隔离与 host action |
| `e780db9eac27e7ce3f77f5e3485ff4624cc9461c` | `ae5fdc3f` | `ead3276c` | INCLUDE | research store 忽略外部 session |
| `a6b23b3f5f2ef24d311053d2eb94cc887060b02e` | `76b400b2` | `54c9ea27` | INCLUDE | 无控制字符字面量的 regex 构造 |
| `a0dd7b9d84d012582f73d6bff6d5fdcd563c8141` | `98f958a7` | `16e4b3d4` | INCLUDE | 并发 HPIAS session slices |
| `24dbfb426fdcaf5e585f3f9d983eb7b8b6c968bc` | `b959aab9` | `e85c1051` | INCLUDE | Frontend build 堆上限 |
| `3d8abb3ee7422caff1bb122c513f2781b80edbc2` | `1003130f` | `2ded044a` | INCLUDE | 单一 HPIAS listener 与 style/srcdoc 清洗 |
| `b868c0ed0cbc6c0426d6a56d67b01565f2774d86` | `16666f30` | `db410150` | INCLUDE | Style Lab reset 保留其他 slices |
| `404646913b0c12d98c256e2e4094929462b1e570` | `eba30ae5` | `d4ba7592` | INCLUDE | 隐藏未注册 action + build 6 GiB |
| `039ca5372d5caaad19e05d7c7b5ff7bae0097ad1` | `5f07c562` | `da087f5a` | INCLUDE | 跳过空 ActionBar toolbar |
| `9bdf8169d9cbe80aa6e7ebf4349e5ee58554b377` | `d6963968` | `5924ce3e` | INCLUDE | undo stack 隔离与 skip-link |
| `a39cb125bebe2f2dd0ddff6174dc9c9222ea8029` | `dfa64912` | `f8a18574` | INCLUDE | URL 清洗与 briefing defaultValue |
| `92bcb5a523771b6c261a13c807a854a7cacc24ed` | `4647c862` | `7632e922` | INCLUDE | 隔离外部 session_started |
| `ab485aa14ed489d4550d81eea1335129b3106613` | `9151c6e8` | `7529230d` | INCLUDE | Rust ingress block allowlist |
| `da42b4980cbab0c4a647d01e5a5e5d0dee8f44f5` | `92ae7cab` | `413b2514` | INCLUDE | Tauri e2e 拒绝未知 block type |

`814d0a28`、`fa6fb8cd`、`2fb56ffb` 因 D 修改了同一技能说明而重新生成
patch；冲突决议只加入各自的 noteEdit/HPIAS 语义，同时保留 D 的
flashcard 仅展示规则。其余 21 项与第六轮 patch-id 等价。

### ALREADY（6 个，不重放）

F `origin/cursor/0824-theme-subapp-cde6` @ `575fee7f` 已吸收全部 #160/#161 项。

| clean SHA | F 对应 | 处置 | 说明 |
|---|---|---|---|
| `638e13df77e914013ae52c89af4e7f9f4083b514` | `2a0be4e5` | ALREADY | 卡库手动新建与 `.apkg` 导入入口 |
| `1de96c8d44b8c28dd4476acd0b6b2de1b28f5941` | `d813e9e4` | ALREADY | pomodoro 宿主存在时隐藏悬浮药丸 |
| `67a5909dccc0aac0a79d0fe5a4a64209d47b670b` | `a9024fc2` + `f538b5a9` | ALREADY | 题库 streak/已答进度 |
| `7b852b437560846d19c38d79fc4712c3705de2eb` | `699bd963` | ALREADY | 删除未渲染 PracticeModeSelector |
| `832edccf85236ee7e02e4db1705dc5c032e38b40` | `450b4443` + `575fee7f` | ALREADY | workbench 壳层交互 |
| `69b96b1fe0efbddf35be244ab5802fce7deca1ab` | `15479c9e` | ALREADY | 卡库新入口 i18n key |

### DROP（9 个，不重放）

| clean SHA | 处置 | 原因 |
|---|---|---|
| `e1fa9bcef8f1c7e05ad6685a664623cc14c09858` | DROP | 回退 A parser/CI 编排 |
| `817b9fd5e589ae252168de4f386f4b45135142ae` | DROP | 回退 A 的 5 个测试契约 |
| `e6d1ffdd2c9d5ca3b70bd5de0299c7ad39291462` | DROP | 坏 YAML，且回退 A scrollbar 契约 |
| `9127956c8d39a61a2f23d77f9ac7ca000c98b8e2` | DROP | 回退 A scrollbar/CI，附带失真 round74 断言 |
| `58e4af56c78cac3cfb5b657649694dab936de49c` | DROP | 把 A 的四分片改回八分片 |
| `2fe74ba65c0772c0e4493af800c3e31b33725371` | DROP | 回退 A 的 8 个契约/测试文件 |
| `6c833a7f5de3e3d8d5eb8c2d6cfcc7c93ee3681c` | DROP | 回退 A/D 的 CardAgent 与相关测试决议 |
| `d6e05976784993301a315683052888dac1e9ebf9` | DROP | 过时审计，错误声称 F 缺 6 项 |
| `5a0eab09dca8e4642bb3465d02aa42247582fed6` | DROP | 绑定旧 clean 基线的过时验证 |

## 门禁

| 门禁 | 结果 |
|---|---|
| `npm ci` | 待跑 |
| `npm run typecheck` | 待跑 |
| `npx vite build` | 待跑 |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | 待跑 |
| 定向 vitest（Generative UI + 触及契约） | 待跑 |
