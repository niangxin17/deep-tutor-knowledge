---
name: deep-tutor-knowledge
description: Read-only local-whitelist knowledge for Deep Tutor. Use list/search/get/domain_counts/graph_snapshot/neighbors; never invent citations or edges.
---

# Deep Tutor Knowledge

## When to use which tool

1. **`knowledge_list_sources`** — Discover allowlisted files under whitelist roots (`methods/…`, `concepts/…`). Optional `learner_id` is accepted but ignored.
2. **`knowledge_search`** — Find relevant file chunks by keyword. Query trim length ≥ 2. Prefer `source_ids` when scoped. Default `limit` 5 (max 20).
3. **`knowledge_get`** — Fetch full file text. Prefer `chunk_id` from a search hit (`source_id#full`). Or pass `source_id` like `methods/费曼一轮.md`.
4. **`knowledge_domain_counts`** — `/studio` card counts. Optional `domains` (default all roots). `items` = file count; `extra.wikilinks` = `[[…]]` count in methods files; `extra.mentions` = concept-title occurrences across all allowlisted files.
5. **`knowledge_graph_snapshot`** — Studio Links overlay. Nodes from allowlist; edges from `[[wikilinks]]`. Modes: `links` | `mutual` | `unresolved` | `all`. Caps: nodes≤80, edges≤400. Empty → `edges: []`, never invent.
6. **`knowledge_graph_neighbors`** — Neighbors of one `node_id` for tooltip / Mutual filter.

## Citations (required)

- Every search hit and get result includes a `citation` (`source_id`, `title`, `locator`).
- **Never invent citations.** Only quote `citation` objects returned by the tools.
- If a tool returns an error (`NOT_FOUND`, `NOT_IN_ALLOWLIST`, etc.), do not fabricate content or sources.

## Policy reminders

- Read-only: no ingest, no delete, no writes.
- Whitelist-only: paths/uris outside configured roots are rejected (`NOT_IN_ALLOWLIST`). Path traversal is rejected the same way.
- Soft errors appear as structured JSON in the tool result text (`code` field).
- Graph: unresolved tokens become `kind: unresolved` with `to: unresolved:<token>`; never invent edges when none exist.

## Typical flow

```
knowledge_list_sources → pick source_ids
knowledge_search({ query, source_ids?, limit? }) → pick chunk_id
knowledge_get({ chunk_id }) → use content + citation

# /studio cards
knowledge_domain_counts({ domains?: ["methods","concepts"] })

# /studio Links overlay
knowledge_graph_snapshot({ mode?: "all"|"links"|"mutual"|"unresolved", top_n?: 8 })
knowledge_graph_neighbors({ node_id, kind?: "all", limit?: 12 })
```

Always surface `citation.path` / node `path` (whitelist-relative) on UI citation bars and deep-links; never invent paths.
