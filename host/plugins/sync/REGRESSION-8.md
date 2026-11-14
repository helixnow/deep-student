# 升级：L20新增8项回归，原样断言与D1所有者接线的冲突证据

**14:03进展**：正常merge main bec9c35ba→b520109b7已带入1a2ed3eb9真实syncSupport装配；两文件原样job20261104140353-20cbc8为39pass/1fail，business25/25通过，故下文第2节装配裁定请求已被正常main集成解除，无需另改测试。第3节L10已回修复a38068281，但尚未在本地main；仍需正常集成及s03/最终gate复验。保留以下初始失败证据，不把历史8fail覆盖成未失败过。

已承认并更正：这8项main通过、合本分支失败，属于L20引入的集成回归。请求裁定如何在不改原断言、不绕过D1的前提闭合，并优先推动owner的精确语义修复；不是将责任推回L23。

## 1. 按指令原样复现

固定工作树HEAD `205380d59b89bfd4bb346e39e98442c71b0ff699`，本地已合main基线 `ad11a83943de411a75c87364fd8893a174ce63f9`。job `20261104135611-f99900`：

```
job.mjs run -- npx vitest run -c vitest.host.config.ts host/plugins/sync-providers/tests/business_tables_sync.test.ts host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts
Test Files 2 failed; Tests 8 failed | 32 passed; exit 1
```

原日志 `/home/dsdev/.oc-jobs/done/20261104135611-f99900.log`。8个名字/断言与架构师清单完全一致，没有修改测试。

## 2. business b04独立最小根因（不与echo水位问题混淆）

job `20261104135801-feab20` 使用真实F3迁移/kernel/vfsRepo/notes/sync，并逐字复制原测试`syncSupport=unused Proxy`装配与b04输入，输出：

```
success_count:0, failure_count:1
failures[0].error: "test unexpectedly entered syncSupport.noteHistory"
actualLength:2
```

此job exit0仅表示打印探针成功，行为仍错误。原输入5MiB y字符串未进入记录写入，原"{}"长度2保留；不是数据截断，也不是476d0d463的日志水位问题。

源码因果：本分支index新增`createNoteHistoryHooks(..., () => ctx.syncSupport.noteHistory)`，note-history.ts:95-96有history表即取reader；原测试business_tables_sync.test.ts:166明确提供throwing syncSupport，:168-170仅安装vfsRepo/notes/sync。本分支因此新增依赖而回归。main以前在L20本地只读查询affectedNotes并有重复笔记写SQL，所以同装配可以通过。R4-SYNC-01/D1要求去掉平行笔记写实现，本分支已委托L10写与L20b读，不能以恢复旧写SQL求绿。

请求裁定：是否允许由测试owner仅补真实syncSupport插件装配（保持全部原场景/输入/断言），或要求L20b发布可直接从api.ts消费的独立只读reader工厂来避免这项新增服务依赖？当前api.ts未公开这样的工厂，L20不能私import其src、复制owner SQL、检测throwing Proxy后fallback，也不会擅自改L23测试。其余b05/b06/b07/b08/b09/b23走相同新增reader入口，但尚不把b04单探针当成七例全部修复证明。

## 3. s03已在真实owner装配下复现：soft-delete Update被错误回滚

job `20261104134646-a9856a`：真实双库迁移、真实kernel/vfsRepo/notes/syncSupport/sync。初次Insert成功2；第二次源日志operation=Update，完整payload的deleted_at非null，目标apply结果：

```
success_count:0, failure_count:1
error:"Database error: Note not found"
target.deleted_at:null; conflicts:[]
```

本分支把remote_sync的inferred-format委托到L10 notes/repository/sync.ts:248，调用getNoteContent过滤已删除笔记。Rust `crates/dstu-sync/src/data_governance/sync/note_history.rs:285-286`原查询`SELECT r.data FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id=?1`没有deleted过滤。故委托后的语义比原Rust窄，导致savepoint回滚，确为本分支启用owner路径后引入的回归。L10 revision.snapshotRestored已用getNoteIncludingDeleted，正确；不能在sync跳过remote snapshot。

已立即向L10提供精确已有窄接口修复请求（仅updateInferredFormat同conn读含soft-deleted；不改变通用getNoteContent普通读语义）。尚未收到修复SHA，L20写权限仍仅sync/。请推动该owner修复正常main或明确扩展授权；不在L20复制其inferred-format算法/SQL。

## 4. 当前交付边界

五条缺失命令已在本分支生产注册，总24/24；真实入口组合在固定205380d59的完整gate `20261104133231-20766c`中run-sync4/shared-permit5/tombstone-ipc4均通过，含真实异步DSBK。不用这些绿覆盖本8项失败。R4-05/06仍待独立闭环。
