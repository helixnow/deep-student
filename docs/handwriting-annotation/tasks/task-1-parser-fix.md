# Scoped strict parser fix

Repo `/home/xutao/deepstudent/deep-student`, branch feat/handwriting-annotation-chat. Fix ONLY `vfs/ink/types.rs` and `mod.rs`, necessary tests.rs and own `tasks/task-1-parser-fix-report.md`. Previous owner stops before you. Main has RED evidence `task-1-validation-green-r3.log`: 9 tests pass, one test accepts forged numeric objects in 2 positions. Existing byte→Value parse collapses serde_json private Number map; recursive key scan after parse is ineffective and discards duplicate keys. Actual VFS serde_json features arbitrary_precision needed by unrelated code, cannot disable globally.

## Deliverable

Minimal robust direct serde_json::from_slice::<T> parse, preserve byte limits and validate calls. REMOVE Value preprocessing/private scan and numeric Number deserialization adapters. Plain f64 fields.

Replace derived Deserialize for InkObjectContent only (retain Serialize with tagged kind snake_case) by strict Deserialize using one ordinary helper struct with deny_unknown_fields. This bypasses internally-tagged serde Content buffering (source of decimal incompatibility).

Suggested exact shape: helper fields `kind:String`, optional `samples:Vec<InkSample>`, `style:InkStrokeStyle`, `rect:InkRect`, `text:String`, `font_size:f64`, `color:String`, `width:f64`, `from:InkPoint`, `to:InkPoint` wrapped Option. Each optional uses `#[serde(default,deserialize_with="present_non_null")]`; helper `present_non_null` deserializes T then returns Some, so explicit null rejected unlike absent. serde derive rejects duplicate fields. Compute number of Some payload fields; match kind, require expected field count AND required fields Some; reject wrong-kind fields even if known elsewhere. Construct variants directly, no raw Value, generic visitor framework or serializer clone.

stroke requires2 samples/style, text4 rect/text/font_size/color, rect/ellipse/region_highlight3 rect/color/width, arrow4 from/to/color/width. Unknown kind rejects. Arrays/text content unchanged. InkSource Blank{} and other enums retain derive (no embedded floats), deny_unknown_fields.

Keep all existing red/green fixture/domain tests unchanged. New focused rejection tests for duplicate x/kind critical keys, variant inappropriate field and null (they may already pass, honest characterization); no huge new suite. Valid decimal positive fixture remains.

No tests/build/install execution, nested agents, commit/push. Main runs exact `cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib vfs::ink::tests` and reviews diff. Return IMPLEMENTED_FOR_REVIEW promptly, <=12 tools ideal; no library exploration needed.
