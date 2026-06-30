# 代理 2 —— 统一数据层与资源中心

> 先读 [README.md](./README.md) 总览,遵守全局规则;状态文档:`docs/6.12/status/agent-2-status.md`。
> 本组是全项目的"地基",结论影响所有组,建议最先产出审阅报告。

## 1. 负责域

统一学习数据层:VFS 虚拟文件系统、向量化流水线、LanceDB 向量存储、DSTU 资源协议、
SQLite 数据库与迁移、文件/教材管理,以及它们的直接视图——学习资源中心 UI。

## 2. 模块清单

### 后端(src-tauri/src)
| 模块 | 路径 | 要点 |
|------|------|------|
| VFS 核心 | `vfs/`(repos、unit_builder、indexing.rs、index_service.rs、embedding_service.rs、lance_store.rs、multimodal_service.rs、pdf_processing_service.rs、todo_handlers.rs 等) | 导入→OCR→分块→Embedding→索引流水线、资源仓储 |
| 向量存储 | `lance_vector_store.rs`(~169KB)、`vector_store.rs` | LanceDB 读写、检索、迁移 |
| DSTU 协议 | `dstu/` | 统一资源寻址/读写 |
| 数据库 | `database/`、`migrations/`、`models.rs`(共享文件,本组是一致性负责人)、`database_optimizations.rs`、`database_indexes.sql` | SQLite schema、迁移、索引 |
| 文件管理 | `file_manager.rs`、`unified_file_manager.rs`、`data_space.rs`、`textbooks_db.rs`、`package_manager.rs` | Blob 存储、数据空间、教材库 |
| 文档处理调度 | `document_processing_service.rs`、`background_tasks.rs`、`startup_cleanup.rs` | 向量化队列调度(OCR 实现属代理 3) |

### 前端(src)
| 模块 | 路径 | 要点 |
|------|------|------|
| 学习资源中心 | `features/learning-hub/`(含 views/IndexStatusView.tsx) | 资源管理器、向量化状态可视化、内容搜索、标签 |
| DSTU 前端 | `src/dstu/` | 资源协议 API 封装 |
| 数据相关 stores/api | `src/api/` 中资源相关封装、`stores/` 中资源状态 | invoke 封装 |

## 3. 不归属本组(别改)
- OCR 引擎与文档解析实现 → 代理 3(本组只调度其产物入索引)。
- 备份/恢复/云同步 → 代理 7(它们消费本组的存储)。
- `commands.rs` 整体架构 → 代理 7(本组只动资源/VFS 相关命令段)。

## 4. 审阅重点清单
- [ ] 向量化流水线:队列调度、失败重试、断点续传、状态上报是否准确(UI 显示与真实状态一致)。
- [ ] Embedding 维度/模型切换时的索引兼容与重建策略。
- [ ] LanceDB 大文件(169KB 源码)读写路径:错误处理、并发安全、数据损坏恢复。
- [ ] SQLite:SQL 注入防护(全部参数化?)、事务边界、迁移脚本可重入性、索引有效性。
- [ ] DSTU 协议:路径遍历风险、权限校验、跨会话资源访问控制。
- [ ] 文件管理:SHA256 去重、孤儿 Blob 清理、磁盘占用治理。
- [ ] models.rs 共享模型:序列化兼容性(serde 默认值)、与前端类型是否同步。
- [ ] 资源中心 UI:大量资源时的列表虚拟化、搜索防抖、向量化状态轮询开销。
- [ ] 删除资源时的级联清理(SQLite 元数据 + Lance 向量 + Blob 文件三处一致性)。

## 5. 跨组接口
- 代理 3 的 OCR/解析输出结构 → 本组入索引:结构变更双方登记同步。
- 代理 1 经 `vfs_resolver` 检索:保持检索接口契约稳定。
- 代理 7 的备份模块读取本组存储布局:存储路径/格式变更必须登记。

## 6. 验证
按 README 3.4 执行;本组重点:`cargo test vfs`、`cargo test dstu`、
`cargo test database`、`npm test -- learning-hub`。迁移类改动需验证全新数据库与
既有数据库两条升级路径。
