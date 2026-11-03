# Task 2 — 统一文档服务、原子保存与引用闭包

状态：后续任务；Task1尚未验收，不得提前实现。主agent已核查并裁决：canonical状态仍为files行，`blob_hash=sha256=当前manifest hash`，`preview_json.ink={schema_version:1,document_id,revision,manifest_blob_hash,blob_refs}`。blob_refs为排序去重页/背景hash，不包含files.blob_hash已单独计数的manifest；manifest是唯一内容事实源，索引仅由服务派生。resources.hash为派生镜像，保存事务与sync批末重协调。dsink同步payload必须带完整一致tuple，不能用partial patch混版。当前与未解决冲突（__sync_conflicts files row快照）的依赖都计入ref/pin，解决后释放。没有证据需要新表；不要新增ink_documents双权威。详见 reviews/storage-sync-findings.md。

Repo `/home/xutao/deepstudent/deep-student`，分支 `feat/handwriting-annotation-chat`。主agent负责审查和测试；实现者不跑测试/构建/安装、不再派agent、不commit/push、不动无关代码。

## 身份细化

`document_id`取提前生成的VFS file ID（`VfsFile::generate_id()`），在写manifest字节之前确定。create/get/save/tool都用这个稳定ID。现通用create_file内部生成ID，不要先发布临时file再重写manifest；受控ink创建可复用helper的最小显式ID变体，或在ink_repo内部用同样资源/文件事务插入，但不能复制整套通用上传管线。默认source回指也存这个ID，不存manifest hash/revision。

## 绑定约束

- `.dsink` / `application/vnd.deepstudent.ink+json` / schema1，仍VFS file。source与page类型只消费Task1，不复制协议。
- canonical manifest唯一可写事实源。revision由服务随机生成不透明值；CAS比较旧manifest blob指针，不依赖file.updated_at。
- UI与工具统一create/get/prepare/save_page/apply_ops服务，通用dstu_update(file/image)仍禁止。
- 新文档document_id写入manifest字节，空白重复内容不去重合并。显式复制重新生成document/page/object身份，背景字节可共享且独立持有引用。
- 所有页/背景依赖与指针切换原子登记；复制/删除/purge/sync重算/GC/备份恢复口径必须相同。JSON写hash不自动保护blob。
- savepoint/事务内只调用_with_conn，不await，不重复获取锁；跨连接staging补偿与事务回滚不能双减引用。
- 来源默认回指只存稳定document ID；创建/挂接同事务；同source重复prepare复用，source_hash变化返回SOURCE_CHANGED，不套旧批注。
- operation_id/input_hash/last_operation为有界幂等：紧邻相同返回原回执、同ID不同输入拒绝；旧操作不能证明则OPERATION_STATE_UNKNOWN，不盲重放。
- 本阶段仅固定背景prepare；PDF/Office渲染由后续桥产出，不允许DB调用前端异步。

## Tests first（真实迁移DB）

正向与负向分批红绿，避免恒Err让负向测试无效。先测试完整create/get最小成功路径→主agent红灯→实现；然后以下有业务断言的组：

1. 同title/空白页创建两份身份、资源/文件行独立；序列化manifest含正确document_id。
2. page保存重开还原样本、revision变更，原blob不被原地覆盖。
3. 旧revision拒绝且不增加对象/切换引用；事务中途失败保持旧文件/资源hash与依赖清单。
4. operation重试相同回执、不重复提交；不同input_hash拒绝；后续编辑后旧operation返回unknown。
5. 复制后两份可独立编辑；删除任一副本不影响另一份页/背景；不要只检查JSON存在，核查真实blob字节/ref_count。
6. 源删除批注仍能读；source_hash变化不复用旧版。
7. purge/ref增减与sync重算一致；GC不删活跃页/背景；旧页引用归零可回收。
8. 同步冲突不将blob_hash/sha256/依赖清单从不同版本拼接，败方保留可读冲突副本。
9. 备份/恢复带完整manifest+pages+background闭包，恢复后可继续保存。

## 交付与门禁

必须先给可编译测试和最小接口，主agent见证红灯后才实现对应组。任何测试不得仅grep源码、复制被测helper作expected或只assert mock调用。0 selected tests不算通过。

报告 `docs/handwriting-annotation/tasks/task-2-report.md`：文件列表、接口、迁移/同步裁决、测试选择器、待主agent执行的命令、known concerns。返回NEEDS_RED_VERIFICATION / IMPLEMENTED_FOR_REVIEW等真实状态，不自称验收通过。

主agent运行：dstu-vfs全lib，dstu-sync引用/GC/backup/restore/冲突相关测试和已有blob引用回归；有迁移则migration fixture upgrade/classification tests；检查SQL原子性/计数。
