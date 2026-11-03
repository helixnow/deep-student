# Task 7 Gate Test Report

Status: `NEEDS_RED_VERIFICATION`

Scope is tests only in `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`.

Added four tests that construct a migrated ChatV2 database, real session and `ChatV2Pipeline`, then call `ApprovalGateHook::before_tool` directly with a windowless emitter. The test fixture registers a simple ink test executor with Medium base sensitivity; the default registry and production policy are unchanged.

- `ink_gate_blocks_destructive_ops_without_manager_under_full_access_presets` checks destructive `builtin-ink_apply_ops` blocks with no manager for Craft + FullAccess and DangerFullAccess.
- `ink_gate_active_plan_binding_does_not_bypass_destructive_ops` persists an active, exact-call Plan binding and checks that a missing manager still blocks the destructive call.
- `ink_gate_does_not_force_approval_for_non_destructive_ops` checks a non-destructive ink add operation proceeds under FullAccess.
- `ink_gate_manager_registers_pending_and_blocks_on_rejection` observes a real manager pending request, delivers a rejection and checks the hook blocks with the reason; then it observes a second pending request, cancels its token, checks blocking and confirms the pending count clears.

The second main run is recorded in `/home/xutao/deepstudent/deep-student/docs/handwriting-annotation/verification/task-7-gate-red-r2.log`: the FullAccess/DangerFullAccess and active Plan behavior tests passed; non-destructive behavior was not reached because a registry-sensitivity `is_none()` implementation-detail assertion failed first. All `is_none()` sensitivity assertions and ApprovalManager absence assertions have now been removed. The approval-scope predicate and policy files were not edited, and the unknown-registry default policy is unchanged. Trusted automation was not investigated or tested. No tests or build were run for this correction; no installation, agents, or commits were performed. Rerun the selector below to verify the corrected non-destructive behavior and new manager pending/rejection/cancellation test.

Exact behavior-test selector for the coordinating agent, from `/home/xutao/deepstudent/deep-student/src-tauri`:

```bash
cargo test --manifest-path crates/dstu-agent/Cargo.toml ink_gate_
```
