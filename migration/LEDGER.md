# 迁移账本：本文件不是账本

这里原来是 2026-11-03 由 `ledger.mjs` 生成的一份快照：当时没有带测试报告，命令 A/B/C 与测试 B 级几乎全部显示 0%。它早已过期，却常被当成当前进度引用，所以移除了数字，只保留指引。

## 实时账本在哪里

- **服务器监控面板**（`scripts/electron-migration/dashboard/server.mjs`）：每次全量测试完整且源码稳定后，按受测提交重算账本，摘要追加到 `.oc-runs/ledger-history.jsonl`，完整结果写在该次全测目录的 `ledger/LEDGER.md` 与 `ledger/ledger.json`。
- **本地重算**：`node scripts/electron-migration/ledger.mjs --vitest latest`，输出到 `.oc-runs/ledger-output/LEDGER.md` 与 `ledger.json`。
  - `--vitest` 可重复给出，接受 vitest JSON reporter 原件（分片各一份；其他机器上的绝对路径会映射回本仓库）、`fulltest.mjs` 合并的 `latest.json`、包含多份报告的目录，`latest` 即 `.oc-runs/fulltest/latest.json`。
  - 不带 `--vitest` 时测试最多算到 A 级。
  - 生成的 `LEDGER.md` 页头写明生成时间、源码提交和测试报告的受测提交；两者不一致时会显式标注。

## 旧的 `migration/ledger.json`

同一次 11-03 生成的旧快照（无测试报告，命令 A/B/C 全 0%）已删除，不再入库；需要文件形式的账本请按上面的方式本地重算。
引用它"为准"的文档（ACCEPTANCE、README §7）已改指向实时账本。

## 指标口径

命令 B 级拆为两个主指标：**B-test**（代码完成 = A ∧ 对应测试在 vitest 报告里全过）与 **B-doc**（文档勾选 = SPEC 两节全勾 ∧
ACCEPTANCE 无未勾选项）。旧 B（= A ∧ B-doc）仅作兼容字段保留。定义见 `scripts/electron-migration/lib/ledger-core.mjs`。
