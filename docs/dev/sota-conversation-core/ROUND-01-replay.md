# 第一轮补充：V20260806 接线核实

来源：[Replay consistency gap](b9e1515d-cbd0-4606-a003-75d9107395a1)

**结论已钉死：迁移只加列，业务零读写。** 注释里的 persistence UPDATE / history 读取不存在。`MessageBlock` 也没有对应字段。

## A / B 分层（实现时必须分开验收）

- **A 同轮重试**：已靠内存做到。`runtime_facts` 与当前 user 编译一次，tool loop 复用；provider id / round_text / reasoning 活在 `PipelineContext` HashMap。技能状态不变则轮内前缀连续。
- **B 跨轮前缀**：未做到。上一轮 user 在 live 是 wrapped + runtime_facts，重放是裸文本 + `---`；tool id 变成 `tc_{uuid}`；round_text 变空。公共前缀停在「上上轮末尾」。更老历史的 DB 视图自身是确定的，但会被 microcompact / FIFO / compaction 再打断。

接线清单：repo INSERT/UPDATE/SELECT、persistence targeted UPDATE、history 三个消费点。不要只改 schema 或只改 MemoryBlock。
