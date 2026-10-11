---
name: deep-tutor-knowledge
description: Read-only local-whitelist knowledge for Deep Tutor. Use list/search/get/domain_counts; never invent citations.
---

# Deep Tutor Knowledge

## When to use which tool

1. **`knowledge_list_sources`** — Discover allowlisted files under whitelist roots (`methods/…`, `concepts/…`). Optional `learner_id` is accepted but ignored.
2. **`knowledge_search`** — Find relevant file chunks by keyword. Query trim length ≥ 2. Prefer `source_ids` when scoped. Default `limit` 5 (max 20).
3. **`knowledge_get`** — Fetch full file text. Prefer `chunk_id` from a search hit (`source_id#full`). Or pass `source_id` like `methods/费曼一轮.md`.
4. **`knowledge_domain_counts`** — `/studio` card counts. Optional `domains` (default all roots). `items` = file count; `extra.wikilinks` = `[[…]]` count in methods files; `extra.mentions` = concept-title occurrences across all allowlisted files.

## Citations (required)

- Every search hit and get result includes a `citation` (`source_id`, `title`, `locator`).
- **Never invent citations.** Only quote `citation` objects returned by the tools.
- If a tool returns an error (`NOT_FOUND`, `NOT_IN_ALLOWLIST`, etc.), do not fabricate content or sources.

## Policy reminders

- Read-only: no ingest, no delete, no writes.
- Whitelist-only: paths/uris outside configured roots are rejected (`NOT_IN_ALLOWLIST`). Path traversal is rejected the same way.
- Soft errors appear as structured JSON in the tool result text (`code` field).

## Typical flow

```
knowledge_list_sources → pick source_ids
knowledge_search({ query, source_ids?, limit? }) → pick chunk_id
knowledge_get({ chunk_id }) → use content + citation

# /studio cards
knowledge_domain_counts({ domains?: ["methods","concepts"] })
```
