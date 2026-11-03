# Task 8 caller fixes

- Both ChatV2 callers now use the shared live Ink delivery-error handler. Trusted renderer results and matching interleaved blocks are marked failed in memory before the existing persistence helper runs; database and block-update errors propagate.
- Ink visual batch insertion now returns a visible ChatV2 error when the tool-result anchor is missing, preventing a provider request without the image.
- Regression coverage was added for database failure, missing insertion anchor, and previously failed renderer/interleaved state.
- The coordinator reported the RED run compiled 53 tests, with 50 passing and these 3 regressions failing as expected. No tests or builds were run after the fixes in this task.
