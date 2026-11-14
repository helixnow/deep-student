# OAuth in-flight cancellation remains blocked

`mcp-oauth-browser.json` / `mcp.pending.oauth.start_with_client_id_then_cancel`
retains `concurrent: [[0,1]]` intentionally. It is not a sequential success case.

- Rust `src-tauri/crates/dstu-mcp/src/mcp/commands.rs:14-40` explicitly awaits
  `start_oauth` until completion, timeout or cancellation. `cancel_mcp_oauth`
  (:43-46) must run while that invocation is pending to test cancellation.
- G3 `scenario-v0.mjs:242-246` awaits each invoke before its waitAfter and the
  next step. A start/wait/cancel sequence would cancel only after start finished,
  changing the tested behavior; an event wait cannot make the invocation concurrent.
- Both G3 runners reject the scenario-level `concurrent` key as unsupported.
  Preserve that outcome until a faithful concurrent driver is separately approved.
  No fabricated success, no deletion of this scenario, no new runner framework here.

This does not block the neighboring OAuth success scenario. Static corpus-check
does not count `concurrent`; include this one unsupported scenario separately in
readiness summaries. Evidence checked at W13 base `891d75ed` (2026-11-07).
