# deep-tutor-knowledge

Read-only **local whitelist** knowledge MCP tools for **Deep Tutor** (`list` / `search` / `get` / `domain_counts` / `graph_snapshot` / `graph_neighbors`).

**Status:** local scaffold only — **not published** to the Cursor marketplace.

## Policy

See [`policy.json`](./policy.json):

| Flag | Value |
|------|-------|
| `mode` | `read_only` |
| `allowlist_only` | `true` |
| `no_ingest` | `true` |
| `no_delete` | `true` |
| `citations_required` | `true` |

Soft errors (JSON in tool result text, often with `isError: true`):

`NOT_IN_ALLOWLIST` | `NOT_FOUND` | `QUERY_TOO_SHORT` | `FORBIDDEN_WRITE` | `INVALID_ARGS`

Path traversal and any path outside configured roots → `NOT_IN_ALLOWLIST`.

## Whitelist (v0.2)

Config: [`server/whitelist.json`](./server/whitelist.json) (or env `KNOWLEDGE_WHITELIST` = absolute path to a whitelist JSON).

```json
{
  "roots": [
    { "id": "methods", "title": "方法库", "kind": "file", "path": "./data/methods", "tags": ["methods"] },
    { "id": "concepts", "title": "概念网络", "kind": "file", "path": "./data/concepts", "tags": ["concepts"] }
  ],
  "extensions": [".md", ".txt", ".yaml", ".yml", ".json"],
  "max_file_bytes": 200000
}
```

Sample Chinese markdown ships under `server/data/methods/` and `server/data/concepts/` so smoke works out of the box.

### Pointing roots at Windows folders later

1. Copy `server/whitelist.json` somewhere writable, or set:
   ```bat
   set KNOWLEDGE_WHITELIST=D:\Gork bot\knowledge-whitelist.json
   ```
2. In that JSON, set root `path` values to absolute folders, e.g.:
   ```json
   { "id": "methods", "title": "方法库", "kind": "file", "path": "D:\\Gork bot\\methods", "tags": ["methods"] }
   ```
   Paths are resolved relative to the whitelist file’s directory when relative; absolute paths are used as-is. Only files under those roots with allowed extensions are readable.

## Domain model

- **sources** — one per allowlisted file (`id` like `methods/费曼一轮.md`, `kind: file`, `uri: file://…`, `tags` from root)
- **chunks** — whole-file units (`chunk_id` = `source_id#full`)
- **citations** — always on search hits and get (`source_id`, `title`, `locator`)

## Layout

```
plugin.json
mcp.json
policy.json
tools.schema.json
skills/deep-tutor-knowledge/SKILL.md
server/index.mjs              # thin MCP stdio wrapper
server/whitelist.json
server/lib/knowledge.mjs      # listSources / search / get / domainCounts (importable)
server/lib/counts.mjs         # re-export of domainCounts
server/data/methods|concepts/ # sample files
server/package.json           # {"type":"module"} — no deps
scripts/smoke.mjs
```

## Install locally in Cursor IDE

### Option A — Cursor Agent Plugin dir

1. Copy or symlink this folder into your Cursor plugins location.
2. Ensure `mcp.json` uses `${CURSOR_PLUGIN_ROOT}` (already set).
3. Reload MCP. Tools: `knowledge_list_sources`, `knowledge_search`, `knowledge_get`, `knowledge_domain_counts`.

### Option B — Project `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "deep-tutor-knowledge": {
      "command": "node",
      "args": ["./deep-tutor-knowledge/server/index.mjs"],
      "cwd": "."
    }
  }
}
```

### Option C — Next.js without spawning MCP (preferred for `/studio`)

Import the same helpers the server uses:

```js
import {
  loadWhitelist,
  domainCounts,
  listSources,
  search,
  get,
} from "../deep-tutor-knowledge/server/lib/knowledge.mjs";
// or copy server/lib/knowledge.mjs into the app

const wl = loadWhitelist("/absolute/path/to/deep-tutor-knowledge/server");
const { counts } = domainCounts(wl, { domains: ["methods", "concepts"] });
// wire methods/concepts card items + extra.wikilinks / extra.mentions
```

Heuristics (MVP):

- **wikilinks** — count of `[[…]]` tokens inside methods-domain files
- **mentions** — sum of case-sensitive occurrences of each concepts-file title across all allowlisted file bodies

## Smoke test

```bash
cd /workspace/deep-tutor-knowledge
node scripts/smoke.mjs
```

Expects exit `0` and a one-line `PASS: ...` summary. No `npm install` required.

## Tools (frozen names)

1. `knowledge_list_sources` — optional `{ learner_id }`
2. `knowledge_search` — `{ query, source_ids?, limit? }`
3. `knowledge_get` — `{ chunk_id }` **or** `{ source_id }`
4. `knowledge_domain_counts` — `{ domains? }` → `{ counts: [{ domain, items, extra }] }`

Full schemas: [`tools.schema.json`](./tools.schema.json).

## Notes for engineers

- **Grok Bot / cloud agents** cannot load local Cursor plugins. Use Cursor IDE or import `server/lib/knowledge.mjs`.
- Do not publish to the marketplace unless PM asks.
- Zero-dep by design. Do not touch `ai-studio` or `dream-icebreaker` main paths.
- Sibling app `niangxin17/deep-tutor` `/studio` currently mocks five-card counts; wire `methods` / `concepts` from `knowledge_domain_counts` or `domainCounts()`.

## Citation path (v0.2.1)

Studio list pages must show the whitelist-relative path from search/get:

- `hit.path` or `hit.citation.path` (e.g. `concepts/费曼复述.md`)
- Never invent a path; empty hits → empty list, no textbook filler.


## Links graph sketch (P1)

See [`tools.links.schema.json`](./tools.links.schema.json): `knowledge_graph_snapshot` + optional `knowledge_graph_neighbors`. P0 UI may mock; empty edges must not invent.

## Graph (v0.3)

Tools: `knowledge_graph_snapshot`, `knowledge_graph_neighbors`. Field names frozen in [`tools.links.schema.json`](./tools.links.schema.json).

- Edges from `[[wikilink]]` tokens in allowlisted files only.
- Kinds: `link` | `mutual` | `unresolved` (unresolved `to` is `unresolved:<token>` + optional `label`).
- Empty edges → `edges: []` / empty overlay lists — **never invent**.
- Caps: `limit_nodes` ≤ 80, `limit_edges` ≤ 400, `top_n` ≤ 20.

```bash
node scripts/smoke.mjs
```

