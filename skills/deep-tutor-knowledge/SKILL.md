---
name: deep-tutor-knowledge
description: Read-only allowlisted knowledge for Deep Tutor. Use list/search/get; never invent citations.
---

# Deep Tutor Knowledge

## When to use which tool

1. **`knowledge_list_sources`** — Discover what the learner may read. Call first when you need source ids/titles/tags. Optional `learner_id` is accepted but ignored in the mock.
2. **`knowledge_search`** — Find relevant chunks by keyword. Always pass a query of length ≥ 2 after trim. Prefer filtering with `source_ids` when the learner is scoped to a unit. Default `limit` is 5 (max 20).
3. **`knowledge_get`** — Fetch full text. Prefer `chunk_id` from a search hit. If only `source_id` is known, the server returns the first chunk for that source.

## Citations (required)

- Every search hit and get result includes a `citation` (`source_id`, `title`, `locator`).
- **Never invent citations.** Only quote `citation` objects returned by the tools.
- If a tool returns an error (`NOT_FOUND`, `NOT_IN_ALLOWLIST`, etc.), do not fabricate content or sources.

## Policy reminders

- Read-only: no ingest, no delete, no writes.
- Allowlist-only: paths/uris outside allowlisted sources are rejected.
- Soft errors appear as structured JSON in the tool result text (`code` field).

## Typical flow

```
knowledge_list_sources → pick source_ids
knowledge_search({ query, source_ids?, limit? }) → pick chunk_id
knowledge_get({ chunk_id }) → use content + citation
```
