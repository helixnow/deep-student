# 存储/同步窄范围结论与主agent裁决 — 2026-11-03

来源：Explore agent_a79b9b97-8d70-44d4-9aaa-67ae0ded81d1（只读，无写权限）。主agent读取了实际field_merge、apply/conflict与file create代码后裁决。

## 已确认代码事实

- `classification.rs:73–81`把files归RowSync/FieldMerge，唯一业务键sha256；真实`field_merge.rs:64–90`只对files.tags_json/is_favorite做merge，其余为同一UPSERT行的LWW。
- `sync/mod.rs:5291–5342`在UPSERT之后对注册列折叠，不会自动合并manifest域。通用变更允许payload缺字段（conflict_resolver.rs:261–288），UPSERT仅设置出现字段，故dsink必须增加完整指针组校验，不能默许部分patch造成新指针/旧deps。
- 没有禁止对同files.id更新sha256的代码。sha256是当前内容业务键，不是稳定文档身份。manifest写入独立document_id，避免不同文档版本内容相同被alias；稳定file.id/manifest.document_id不能被hash替代。
- file创建将resources.hash初始化为sha256（file_repo.rs:120–147），但resources独立LWW；dsink需要在本地保存及同步批末显式以files权威行重协调镜像，不能称已有机制。
- 实际guard保存双方整行快照至__sync_conflicts（sync/mod.rs:7911–7951；commands_backup.rs:517–525），但recompute手工枚举preview.pages，未覆盖preview.ink或冲突row JSON；故“有冲突副本”不等于依赖blob有ref。
- sync批次DB有事务（普通7035–7062/7175–7187，guard7760+），blob字节走独立文件同步（classification365–375、mod11168+）。不能宣称跨云对象/DB事务天然原子。

## 主agent选择

Ruling: 复用现有files行的blob_hash/sha256/preview_json.ink，不新增ink_documents表 — 原manifest仍唯一内容事实源、列表字段为服务派生索引；完整行LWW无需第二权威表 — 若完整性校验漏做会混合版本，需负向/冲突/GC测试强制门禁。

规范派生索引：`preview_json.ink`包含schema_version、document_id、revision、manifest_blob_hash、规范排序去重blob_refs（页正文与背景；manifest主引用由files.blob_hash单独计数，避免双计）。实际字段值在Task2实现前固定。读取必须验证manifest与索引，不允许调用方单独编辑索引。resources.hash只作可重建镜像，不另存一份可写笔迹。

新增dsink同步guard：识别现存或输入dsink文件，拒绝不完整/不一致canonical字段组；没有依赖blob时隔离/延迟，不可发布不可读指针。同步批末修复资源镜像并按格式重算current与未解决conflict引用。冲突resolve后释放pin要与原resolve事务/GC口径一致。fail-closed不会保证云对象原子，需要明确可重试状态。

## 必须证明的测试

- 同document两设备竞争后，pointer/hash/revision/deps来自同一胜方。
- 缺canonical字段或伪造deps拒绝，不以局部patch混用旧索引。
- 未解决冲突的manifest/page/background都可读且GC不删；resolve后不再持有不必要pin。
- 本地保存、复制、purge、DSTU purge、sync重算计数一致；page/background重复hash口径明确。
- 来源删除仍可读、资源hash镜像重协调、blob缺失/失败时不发布指针。
- 备份恢复完整闭包且可继续编辑。

## 边界

探索未跑测试；以上不代表Task2已实现。原先agent建议新表经主agent质询已修正，不以过度推断新增schema。
