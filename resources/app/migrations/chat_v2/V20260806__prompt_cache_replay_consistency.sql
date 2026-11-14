-- Prompt-cache replay consistency (2026-08, absorbed from the downstream
-- "big cache refactor" experience):
--
-- Provider prefix caches (DeepSeek/OpenAI/Anthropic) match the request from
-- the first byte. Cross-turn hits therefore require the replayed history to be
-- byte-identical to what was sent live. These columns persist the exact data
-- needed to reconstruct live bytes on replay:
--
--   llm_content   - user message content block: the exact LLM-visible text
--                   (wrapped <user_query>/<injected_context> + dynamic tail)
--                   that was sent live, so replay does not rebuild different
--                   bytes from the raw stored content.
--   tool_call_id  - tool result block: the original provider tool-call id
--                   (e.g. "call_..."). Live messages carry it; replay used to
--                   derive "tc_{block_id}", which diverged at the first tool
--                   call and invalidated the whole following prefix.
--   round_text    - tool result block: the assistant's text emitted right
--                   before the tool call (text-before-tool-use), which live
--                   rounds attach to the first assistant tool-call message but
--                   replay previously lost (empty string).
--
-- These are written via targeted UPDATEs by persistence.rs and read by
-- history.rs (replay); MessageBlock is intentionally left untouched.

ALTER TABLE chat_v2_blocks ADD COLUMN llm_content TEXT;
ALTER TABLE chat_v2_blocks ADD COLUMN tool_call_id TEXT;
ALTER TABLE chat_v2_blocks ADD COLUMN round_text TEXT;
