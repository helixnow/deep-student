---
name: commit
description: Create a well-structured git commit from staged changes. Use when the user asks to commit, write a commit message, or finalize staged work. Prefer manual invocation for side-effect control.
disable-model-invocation: true
user-invocable: true
argument-hint: "[scope]"
license: MIT
tags: [git, workflow]
---

# Commit

Only run after the user explicitly invokes `/commit`.

1. Inspect `git status` and `git diff --staged`
2. Draft a concise commit message
3. Commit staged changes (never push)
