# Project Governance & Repository Discipline

DeepStudent follows a transparent, trunk-based open-source governance model.

## Branch & Merge Discipline

- **Trunk-Based Development**: `main` is the sole long-lived development branch (alongside the automated `cla-signatures` metadata branch).
- **Short-Lived Feature Branches**: all changes—including maintainer and AI-assisted changes—must be developed on short-lived branches (`feat/*`, `fix/*`, `chore/*`, `docs/*`, `refactor/*`) and merged via Pull Request.
- **Green CI & Linear History**: PRs must pass all required checks (`Frontend`, `Backend`, `CI Required`, and semantic PR title validation) and merge via **Squash and Merge** to keep `main` atomic and bisectable. Merged branches are deleted automatically.
- **Immutable Release Tags**: release tags matching `v*` are protected against deletion and force-updates. Pre-releases use `vX.Y.Z-rc.N`.

## Public Repository Surface Policy

`helixnow/deep-student` contains **only** product source code, runtime/test fixtures, build & release configs, and user/contributor documentation. Internal roadmaps, competitor research, private benchmarks, and scratch process logs belong outside this repository and are blocked in CI by `npm run check:public-surface`.

## Roles & Decision Making

- **Contributors**: anyone submitting Issues, Discussions, or Pull Requests (requires CLA signature for code contributions).
- **Maintainers**: core stewards responsible for code review, security response, architecture coherence, and release sign-off (`CODEOWNERS`).
- **Breaking Changes & Architecture Decisions**: breaking changes to IPC contracts, database schemas, or Plugin v2 APIs must be proposed in a GitHub Issue or Discussion before implementation and labeled `breaking-change`.
