# Task8 production image placement — gate report

Status: `HISTORY_AND_LIVE_CALLERS_IMPLEMENTED — LIVE CALLER GATE PENDING`

## First-gate test

Added `history_replays_trusted_ink_artifact_after_complete_parallel_tool_round` in `/home/xutao/deepstudent/deep-student/src-tauri/crates/dstu-agent/src/chat_v2/pipeline/history.rs`. It uses migrated ChatV2 and VFS databases, stores a valid 1x1 PNG through `VfsInkArtifactRepo`, persists and reloads the typed `MessageBlock.ink_artifacts` ref, then feeds two tool results in one assistant message through the existing history assembler. The positive assertions require the image-bearing user message to follow both assistant/tool pairs, decode to the original PNG bytes, and replay the same persisted refs to the same bytes. An MCP-like sibling tool result contains a loopback `image_url`; a local listener asserts replay never requests it.

The pre-change RED was executed by main and is recorded in `/home/xutao/deepstudent/deep-student/docs/handwriting-annotation/verification/task-8-placement-red-r2.log`. It failed at the intended role-sequence assertion (history lacked the image-bearing `user` after the complete two-tool group), after successful compilation and fixture setup. Main’s `/home/xutao/deepstudent/deep-student/docs/handwriting-annotation/verification/ink-agent-r5.log` later reports the history replay test and live-round helper positive both passing. Those green results predate the production tool-loop and multi-variant caller wiring below and do not verify those callers.

## API choices / trust boundary

- `MessageBlock.ink_artifacts` is the persisted typed source. `ToolResultInfo` has no typed-ref field; do not parse image URLs or refs out of `ToolResultInfo.output` / arbitrary tool output.
- Only the exact trusted renderer names `builtin-ink_render` and `ink_render` may compile typed refs. The compiler checks session/tool-call/round-anchor identity and immutable artifact provenance against VFS before producing a user multimodal message.
- The live path now uses `ToolResultInfo.block_id` to load successful trusted renderer blocks, verifies the stored parent message/session/tool identity, rebinds typed refs to the completed round's final call id and persists that anchor before compiling. Existing assistant/tool message pairs remain intact; the transient image user message is anchored after the full round.
- Live single- and multi-variant tool rounds call the shared preparation/compiler helper immediately after the round completes and before adding tool results for the next provider request. Both maintain a request-local count/decoded-byte budget shared with retrieval page images; arbitrary output image URLs remain tool text.
- On non-vision routes or invalid refs/artifacts/budget failures, the live caller converts successful renderer results to structured `VISION_MODEL_REQUIRED` or `IMAGE_DELIVERY_FAILED` tool failures and updates the stored block status/output before the next request.

## Scope and remaining checks

Production history placement is implemented in `pipeline/history.rs` with `pipeline/ink_visual_rounds.rs`. It uses persisted typed refs only, validates trusted renderer/session/message/tool-call/round identity and persisted ref JSON, resolves actual immutable VFS PNGs, and inserts the image user message after the full anchored tool-result group. History selection is recency-bounded to `DEFAULT_HISTORY_IMAGE_BUDGET`; older skipped rounds receive a hidden notice that their images were not delivered.

The live single-variant `tool_loop.rs` and multi-variant `multi_variant.rs` complete-round paths now call the shared preparation/compiler before adding results for the next provider request, bind and persist the final round anchor, reuse a count/decoded-byte image budget with retrieval page images, and retain the image user message after the whole parallel result group. Invalid image delivery and text-only routes become structured renderer failures and error blocks before the next provider call. Frozen-context compilation and the live loop reject pending historical ink images on a text-only route with `VISION_MODEL_REQUIRED`.

Main’s `ink-agent-r5.log` reports 46 passed, including the history replay and live-helper positive test (actual PNG bytes and corrected persisted round anchor). Those tests passed before the production callers were wired, so the caller changes in this session are **unverified**. This session ran no tests/builds/installations; main owns verification and review. No commits or pushes were made.

Still required: main’s verification/review of the live callers and the separate owner’s offline local HTTP captures for OpenAI, Responses, and Anthropic, asserting correct image role/order and image payload (not a JSON URL), deduplication and the 4-image/16-MiB shared budget, plus fail-closed non-vision and forged-ref behavior. No actual provider/model/network fee is needed.
