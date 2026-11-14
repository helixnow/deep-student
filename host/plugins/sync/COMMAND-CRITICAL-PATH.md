# 架构师关键路径补缺响应（2026-11-04）

**13:28最新**：main ad11a8394 已合入L20b异步codec，五条命令已由L20正式index/API接线，总24/24。真实owner+HTTP入口job132424-3d8946（12pass）/132718-b09cfb（4pass，含异步DSBK）均exit0。以下为集成前阻塞历史，不再请求重做已合入的codec；当前剩余R4-05/06待消费各owner正常main后继。正式完整gate待本轮结果，完整语义/独立签收不因注册自动通过。

当前生产 `index.ts` 注册19/24，旧“缺8”中的import_sync_data、resolve_record_conflict、rollback_sync_snapshot_batch已接L21共享许可并注册（f53290429之前的正常本lane提交，真实kernel证据见REPORT）。仍缺5条：run_sync、run_sync_with_progress、mark_blob_deleted、mark_asset_deleted、list_unsynced_items。

五条已有函数与原分支编排，但共同缺正式main的 **L20b异步tombstone codec**：当前main `sync-support/api.ts:49-51` encode/decode返回Uint8Array；真实F4 DSBK为Promise。L20b分支head `cae04c341` 已发布 Uint8Array | Promise<Uint8Array> 并await真实实现。不能用强转、plaintext-only或自写tombstone副本注册命令伪闭环。请求C2优先推动L20b候选正常门禁/合入main，主路径五条即可一起消费；不是要求再实现旧接口。L21正式limiter/SSOT/audit与D7跨库apply已经可用。

另两项高危R4阻塞也已有owner具体进展：F3分支head `4f3db3e42` api.ts已公开createDatabaseWorkerPool、多库worker context、URI/copy接口，尚未到本lane当前main；合入后可消费并推进R4-SYNC-06。L17回执 `d2c80ee3f` 已从memory/api.ts公开mergeProfileJsonForSync纯函数，待正常集成后接默认apply与guard；已知R5-M4浮点词法/fingerprint差异仍属owner待修，原向量通过不统签。

历史自检 `20261104124638-4d275f` tests exit1为sync-providers文件中58失败；其他4项exit0。**更正归因：这些不能称作L23既有失败，本分支改变apply/hook依赖后引发的新增回归仍由L20负责闭环。** L23候选`0857c65b7`的真实服务装配变动是相关证据，不代表L20可自行免责或改测试。最新8项的精确诊断与升级申请见REGRESSION-8.md。

顺序：R4正确性→五命令实际生产闭环→其他X6自查。命令完成清单保留在SPEC各命令节，未通过真实入口/原断言/门禁前不提升A/B。
