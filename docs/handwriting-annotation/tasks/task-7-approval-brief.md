# Task7授权独立切片 — 精确范围与不可绕过门禁

read first. Repo `/home/xutao/deepstudent/deep-student`, branch feat/handwriting-annotation-chat。Task7六工具尚未实施，以下只做独立权限判定与真实hook门禁，不动executor/schema/UI。操作协议固定`ops`数组、`op=update_object|remove_object|add_text|add_rect|add_arrow|add_ellipse|add_region_highlight|append_blank_page`，工具bare `ink_apply_ops` / builtin前缀兼容。

Allowed: `dstu-agent/src/chat_v2/{approval_scope.rs,tool_approval_policy.rs,pipeline/hooks.rs}`的最小修改与测试，必要仅authority_mode.rs的具体predicate抽取（先说明原因），任务报告。禁止repo/blocks/storage/render/工具注册等其他文件；不会并行改这些权限文件。

## Gate

FIRST TESTS ONLY against actual existing helpers/hooks (new unknown ink calls should not yet get needed exact behavior)；若需要predicate API，最小返回false scaffold，正向测试能编译且失败，不以缺符号编译错当red。不要生产实现。主agent亲自运行预期red后授权实现。NO tests/build/install/agents/commits。

## 行为

- `ink_apply_ops`若含update_object/remove_object（无论声明作者/是否AI），为破坏性精确一次审批；缺ops/错误格式不能绕授权变Low（executor将拒绝参数）。所有带human修改可能性的操作在未知作者时保守处理。
- scope绑定document_id + expected_revision + 有序ops payload hash（位置render/crop和对象id变化会变scope），不是仅工具名/大组/全局。input顺序不可丢失。never-remember，参数内容不泄露到日志。
- broad tool/group/global Low override不降低该破坏性审批。FullAccess/DangerFullAccess、Plan binding、trusted automation也必须走实际ApprovalManager一次性确认；manager不可用fail closed。
- 仅识别/get/render无写入授权；本切片只判定破坏性强制门，不为普通create/add授予自动写入许可。
- 现有其他工具行为不变，非破坏性ink不误加额外强制审批。

## 初始测试

1. destructive args被识别、精确scope包含所有边界（不同doc/rev/order/render/target/content得到不同scope），same args稳定。
2. never remember，broad bypass/tool/group低敏override不降。
3. 实际hook或最小真实predicate验证FullAccess/Plan/trusted自动化均无法绕；不要只assert enum常量或源码包含文字。

阅读 reviews/chat-integration-findings.md 的权限段与文件行号，不再探索所有Chat。参考已有approval_scope相邻测试。报告 tasks/task-7-approval-report.md 写selectors、编译API、待主agent执行命令。首次只落盘当前小批，不等全面体系重构，停止NEEDS_RED_VERIFICATION。
