# Development contract

This repository contains public code and synthetic fixtures, never private memory or credentials.

- Markdown is canonical. `src/format.mjs` owns URI, validation, serialization and lexical scoring.
- Keep six MCP tools and bounded context. No embeddings, rerank providers, calendar, reminders or private bridge.
- Local writes coordinate through an OS-local cross-process lock and check etags inside it. External editing and device synchronization remain outside that lock.
- Keep installs free of lifecycle setup side effects. Seed only a fresh library; explicit init can add a missing guide. Never overwrite user documents on upgrade.
- Always use temporary roots for tests. Never run development writes against a user's default library.
- Verify changes with `npm test`, a packed-package installation smoke test, and appropriate real transport checks. Preserve protocol stdout.
- Sync conflicts are evidence to review, not memories to index. Never silently merge or ignore them.
- Publishing requires current human authorization. Check the package allowlist and the Git diff before releasing; do not publish debug fixtures or credentials.
