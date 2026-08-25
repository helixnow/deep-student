# Anki options consistency audit

## Scope

- Audited every repository occurrence of `AnkiGenerationOptions { ... }`.
- Audited the new modules that independently deserialize
  `anki_generation_options_json`: `anki_protocol`, `anki_critic`, and
  `anki_model_routing`.
- Compared each wire field's missing-value behavior with the corresponding
  `AnkiGenerationOptions` serde behavior.

## Findings and repairs

`output_protocol` and `enable_qa_pass` were already represented in
`AnkiGenerationOptions` with serde defaults matching
`StructuredOutputOptions`.

The following existing new-module wire fields were not represented in the
main options struct:

| Field | Existing module default |
| --- | --- |
| `enable_critic_pass` | `None`, critic disabled |
| `enable_llm_critic` | `None`, critic disabled |
| `critic_token_budget` | `None`, use `CriticConfig::default()` |
| `sidekick_model_routing` | `None`, auto routing |

All four are now optional `AnkiGenerationOptions` fields with
`#[serde(default, skip_serializing_if = "Option::is_none")]`. This preserves
the existing missing-value behavior and does not change default generation.

All exhaustive Rust literals were updated with explicit `None` values:

- the default and two test literals in `enhanced_anki_service.rs`;
- the ChatAnki construction path in `chatanki_executor.rs`.

The remaining constructors use serde deserialization and intentionally rely
on field defaults, so no literal update is required.

## Verification

- Full-repository literal search: no incomplete `AnkiGenerationOptions`
  literal remains.
- `cargo check --lib`: passed.
