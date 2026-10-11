# deep-tutor-knowledge

Read-only allowlisted knowledge MCP tools for **Deep Tutor** (`list` / `search` / `get`).

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

## Domain model

- **sources** — allowlisted documents (`id`, `title`, `kind`, `uri`, `tags`)
- **chunks** — text units under a source (`chunk_id`, `source_id`, `title`, `content`, `locator`)
- **citations** — always returned on search hits and get (`source_id`, `title`, `locator`)

Mock data lives in [`server/allowlist.json`](./server/allowlist.json) (中学理科 / 费曼学习法).

## Layout

```
plugin.json                 # Agent Plugin root manifest
mcp.json                    # stdio server (${CURSOR_PLUGIN_ROOT})
policy.json
tools.schema.json           # frozen tool field names
skills/deep-tutor-knowledge/SKILL.md
server/index.mjs            # zero-dep Node ESM MCP stdio server
server/allowlist.json
server/package.json         # {"type":"module"} only — no deps
scripts/smoke.mjs
```

## Install locally in Cursor IDE

Agent Plugins can be loaded from a **local plugin directory** (if your Cursor build supports it) or from the marketplace after publish. This package is **not** published.

### Option A — Cursor Agent Plugin dir

1. Copy or symlink this folder into your Cursor plugins location (product-specific; often under user Cursor config / plugins).
2. Ensure `mcp.json` uses `${CURSOR_PLUGIN_ROOT}` (already set). Cursor expands `CURSOR_PLUGIN_ROOT`; it does **not** expand `PLUGIN_ROOT`.
3. Reload MCP / restart Cursor. You should see server `deep-tutor-knowledge` with tools:
   - `knowledge_list_sources`
   - `knowledge_search`
   - `knowledge_get`

### Option B — Project `.cursor/mcp.json` (deep-tutor app)

For the Next.js mock app (`niangxin17/deep-tutor`, e.g. `:3001`), wire the same server with an **absolute or relative path** — no `CURSOR_PLUGIN_ROOT` needed:

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

Or with an absolute path:

```json
{
  "mcpServers": {
    "deep-tutor-knowledge": {
      "command": "node",
      "args": ["/workspace/deep-tutor-knowledge/server/index.mjs"],
      "cwd": "/workspace/deep-tutor-knowledge"
    }
  }
}
```

### Option C — Next.js mock without MCP

Import or `fetch` the same allowlist JSON the server uses:

```ts
// e.g. app/api/knowledge/route.ts or a mock module
import allowlist from "../../deep-tutor-knowledge/server/allowlist.json";
// expose list/search/get over HTTP mirroring tools.schema.json
```

Point at `server/allowlist.json` so IDE MCP and the web mock stay in sync.

## Smoke test

```bash
cd /workspace/deep-tutor-knowledge
node scripts/smoke.mjs
```

Expects exit `0` and a one-line `PASS: ...` summary. No `npm install` required.

## Tools (frozen names)

1. `knowledge_list_sources` — optional `{ learner_id }` (ignored in mock)
2. `knowledge_search` — `{ query, source_ids?, limit? }` (default limit 5, max 20)
3. `knowledge_get` — `{ chunk_id }` **or** `{ source_id }`

Full schemas: [`tools.schema.json`](./tools.schema.json). Skill guidance: [`skills/deep-tutor-knowledge/SKILL.md`](./skills/deep-tutor-knowledge/SKILL.md).

## Notes for engineers

- **Grok Bot / cloud agents** cannot load local Cursor plugins. Use Cursor IDE with a local plugin dir or project MCP config.
- Do not publish this to the marketplace unless PM asks.
- Zero-dep by design (Poteto Mode laziness): no `@modelcontextprotocol/sdk` until an SDK earns it.
- Sibling app `niangxin17/deep-tutor` is built separately; do not touch `ai-studio` or `dream-icebreaker`.
