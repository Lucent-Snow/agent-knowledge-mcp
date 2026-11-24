# Development contract

This repository contains public code and synthetic fixtures, never private memory or credentials.

- Markdown is canonical. `src/format.mjs` owns URI, path mapping, validation and serialization; `src/ranking.mjs` and `src/lexical-index.mjs` own BM25F lexical scoring and optional RRF/rerank orchestration; `src/sections.mjs` owns explicit `<!-- knowledge:history -->` section parsing.
- Keep seven MCP tools, five memory types (`context`, `project`, `note`, `identity`, `skill`), and bounded context. Local BM25F works zero-config offline; OpenAI-compatible embeddings and rerank are strictly opt-in via environment variables with fail-soft fallback. Do not add calendar, reminders, or private bridge integrations.
- Keep caches and maintenance checkpoints outside the synced corpus, and isolate them in temporary directories during tests.
- Local writes coordinate through an OS-local cross-process lock and check etags inside it. External editing and device synchronization remain outside that lock.
- Keep installs free of lifecycle setup side effects. Seed only a fresh library; explicit init can add a missing guide. Never overwrite user documents on upgrade.
- Always use temporary roots for tests. Never run development writes against a user's default library.
- Verify changes with `npm test`, a packed-package installation smoke test, and appropriate real transport checks. Preserve protocol stdout.
- Sync conflicts are evidence to review, not memories to index. Never silently merge or ignore them.
- Publishing requires current human authorization. Check the package allowlist and the Git diff before releasing; do not publish debug fixtures or credentials.
