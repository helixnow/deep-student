# 候选提供方复核测试

这里的测试用于复核 **未合 main** 的 F7/L16 候选接口（L05 adapter 已随 main
合入，blob 与候选一致）。main 缺少 F7/L16 候选文件时测试会自动 `skip`，不能
把 skip 当作通过；在候选 worktree 中运行后，证据才成立。
这些测试不计入 TESTMAP 的 `ported`；相关 Rust 行继续保持 pending。

## 1. L05 + F7 Linux 硬沙箱

测试：`l05-linux-sandbox.test.ts`（7 个 Rust `chatanki_transform_script.rs::e2e_*`
场景 + capability/contract，共 8 个）。

提供方固定点：

| 提供方 | 分支 HEAD | 文件 blob |
|---|---|---|
| L05 adapter（已合 main） | `ds-mig/L05-agent-workspace` `ff52577c4aeac9c9fe737c32cbabfb3f1ad65c3c`（main blob 相同） | `host/plugins/agent-workspace/src/tools/transform-sandbox.ts` `1011746922259ba3723f0d38d3cd4a84c962949f` |
| L05 policy | 同上 | `host/plugins/agent-workspace/src/tools/shell-sandbox.ts` `396cce245e5fe7afdd1e299a9f6753e398763ca7` |
| F7 sandbox API | `ds-mig/F7-native` `83e078af283f31860e72634d7dfc8cc9ab78fcd9` | `host/platform/native/sandbox/api.ts` `eaaa82acf66a3ea9d368d3421a2be09ea606ee37` |
| F7 sandbox impl | 同上 | `host/platform/native/sandbox/index.ts` `0fc335fc20519f5b3260e75cc2a94c6985cbffdd` |

复核命令（在 lane 仓库根执行；Linux + `/usr/bin/bwrap` + `/usr/bin/prlimit`）：

```sh
ROOT=$(git rev-parse --show-toplevel)
WT=/tmp/opencode/l24-candidate-l05
git worktree add --detach "$WT" 231c0a561
ln -s "$ROOT/node_modules" "$WT/node_modules"
mkdir -p "$WT/host/plugins/agent-workspace/src/tools" "$WT/host/platform/native/sandbox"
git show ds-mig/L05-agent-workspace:host/plugins/agent-workspace/src/tools/transform-sandbox.ts \
  > "$WT/host/plugins/agent-workspace/src/tools/transform-sandbox.ts"
git show ds-mig/L05-agent-workspace:host/plugins/agent-workspace/src/tools/shell-sandbox.ts \
  > "$WT/host/plugins/agent-workspace/src/tools/shell-sandbox.ts"
git show ds-mig/L05-agent-workspace:host/plugins/agent-workspace/src/tools/shell-sandbox-windows.ts \
  > "$WT/host/plugins/agent-workspace/src/tools/shell-sandbox-windows.ts"
git show ds-mig/F7-native:host/platform/native/sandbox/api.ts \
  > "$WT/host/platform/native/sandbox/api.ts"
git show ds-mig/F7-native:host/platform/native/sandbox/index.ts \
  > "$WT/host/platform/native/sandbox/index.ts"
cd "$WT"
npx vitest run -c vitest.host.config.ts \
  host/plugins/chatanki/tests/candidates/l05-linux-sandbox.test.ts
```

预期：`8 passed`。证据作业：`20261104091936-012e18`（当前 lane 测试文件
+ 上述候选，退出码 0，8 tests）、`20261104082217-1e212c`（lane `231c0a561`
+ 上述候选，退出码 0）；早先同场景作业 `20261104075253-b63b15`
（lane `0e7e3800d`，退出码 0）。macOS Seatbelt / Windows AppContainer 未在本机
实测；Windows native bridge 存在不等于七个业务脚本 e2e 已完成。

## 2. L15 真实 CAS（main 类 + 未发布服务 API）

测试：`../review-executor-real-l15.test.ts`（4 个用例），不需要复制候选文件；
main 的 `host/plugins/review/src/review.ts`（blob
`537458ad20d564e88303146b538fb11599b3d6b3`）已包含真实
`FsrsReviewService::setSuspendedForSession` CAS。

```sh
cd "$ROOT"
npx vitest run -c vitest.host.config.ts \
  host/plugins/chatanki/tests/review-executor-real-l15.test.ts
```

预期：`4 passed`。证据作业：`20261104083031-e0008a`（退出码 0）；
本 lane 全量作业 `20261104083533-555bdc`（main 合入后，
`356 passed / 8 skipped`，退出码 0）也包含这四条。注意：`review` 插件发布的 `ReviewService` API 仍未暴露这两个方法，
因此该测试证明 parser → `FsrsReviewService` CAS，不证明生产
`ctx.get('review')` hydration；L15 服务 API 发布前，`chatanki_set_suspended` /
`chatanki_undo_last_review` 的 production wiring 仍记 pending。

L16 `deleteCardForSession` 的真实大整数 CAS 没有在当前测试中验证，继续保持
pending，不能用本目录的测试替代。

## 3. L16 真实 `deleteCardForSession` CAS

测试：`l16-anki-delete-cas.test.ts`（4 个用例：真实 L16 仓储物理删除、内容版本
冲突、复习版本冲突、大整数 review version pass-through）。

提供方固定点：`ds-mig/L16-anki` HEAD
`68a71d24854fd7f4290fa0d6c3add1f484db8399`（`22fa0400b` 之后的提交只改
文档；下表 blob 与 22fa 时相同，均按内容哈希复核）。

| 文件 | blob |
|---|---|
| `host/plugins/anki/tests/env.ts` | `af0a81771b8adcf1a4434dfa7adc0c29d988aad2` |
| `host/plugins/anki/src/service.ts` | `d2436e388501784b04c84b4d3344f1a1a825b4d5` |
| `host/plugins/anki/repository/chatanki-surface.ts` | `999e7b587942f4394206fa36f5f5b5bd9b801e8e` |
| `host/plugins/anki/src/chatanki-service-adapters.ts` | `1537f34a2981c73ce4aeee6ccfb7be26fa2a1b94` |
| `host/plugins/anki/src/fsrs-owner.ts` | `45ca160fd69b356cf682edfbd4046f182f29504d` |
| L16 candidate `host/plugins/review/index.ts` | `890d6ebbd0fc302ade65fb89080f2d12db593ae3` |
| L16 candidate `host/plugins/review/src/review.ts` | `fe5b49cf6e0d938dfe8b313b3d10a4061b574c25` |

复核命令：

```sh
ROOT=$(git rev-parse --show-toplevel)
WT=/tmp/opencode/l24-candidate-l16
git worktree add --detach "$WT" 68a71d24854fd7f4290fa0d6c3add1f484db8399
ln -s "$ROOT/node_modules" "$WT/node_modules"
rm -rf "$WT/host/plugins/chatanki"
cp -a "$ROOT/host/plugins/chatanki" "$WT/host/plugins/chatanki"
cd "$WT"
npx vitest run -c vitest.host.config.ts \
  host/plugins/chatanki/tests/candidates/l16-anki-delete-cas.test.ts
```

预期：`4 passed`。证据作业：`20261104085554-c90c0c`（退出码 0，lane 测试文件
提交于 `dc9082f7a`）。该测试用本 lane 生产 `chatanki_delete_card` 经
`chatankiTools.execute` hydration 进入 L16 真实 SQLite 事务，断言物理删除后
`anki_cards` / `fsrs_card_states` 均无行，以及内容/复习 CAS 冲突不写库；但它
仍是候选复核，不计 TESTMAP ported。main 的 `anki` 服务尚未发布 `cards`，所以
main 上该文件自动 skip。

## 4. 未提交临时测试不计 ported

本目录测试只做候选复核；TESTMAP 的 7 个 L05 `e2e_*`、L15 服务 API 行与 L16
CAS/仓储行仍按 main 实际发布状态保持 pending。不要把本目录的通过结果写入
`ported:`。
