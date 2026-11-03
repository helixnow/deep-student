# Task 8 — provider wire acceptance

Status: acceptance tests added; not executed by this worker (main owns test/build execution).

Three tests in `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline/handwriting_provider_capture_tests.rs` invoke `LLMManager::call_unified_model_2_stream_with_config`, which assembles the real legacy `ChatMessage` history and routes it through the production provider adapter and HTTP client. Each test binds a capture server exclusively to `127.0.0.1`, uses a fake API key and a bounded no-proxy client, captures the serialized request body, and returns a minimal successful provider stream. No external request, credential/environment lookup, or model invocation is involved.

The history contains two assistant tool calls (`call_parallel_a`, `call_parallel_b`), their corresponding tool results, then a user multimodal message containing `MultimodalContentPart::ImageUrl { media_type: "image/png", base64 }`. The PNG is encoded from a generated 1×1 RGBA pixel in memory. Assertions check protocol-specific typed image blocks and decode the captured data URL/base64 back to the exact generated PNG bytes; they also check tool order and each result's parent call ID. This validates request transport/serialization only, not model-side handwriting interpretation.

## Selectors

Run from `src-tauri/`:

- `cargo test -p dstu-llm --lib llm_manager::model2_pipeline::handwriting_provider_capture_tests::local_openai_chat_completions_request_carries_handwriting_png_after_parallel_tools -- --exact`
- `cargo test -p dstu-llm --lib llm_manager::model2_pipeline::handwriting_provider_capture_tests::local_openai_responses_request_carries_typed_handwriting_png_after_parallel_tools -- --exact`
- `cargo test -p dstu-llm --lib llm_manager::model2_pipeline::handwriting_provider_capture_tests::local_anthropic_request_carries_base64_handwriting_png_after_parallel_tools -- --exact`

The three provider selectors are isolated. Main should report their execution result and any provider/API contract gap discovered by the capture assertions.
