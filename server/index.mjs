#!/usr/bin/env node
/**
 * Zero-dep MCP stdio server for deep-tutor-knowledge.
 * Content-Length framed JSON-RPC 2.0.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(
  readFileSync(join(__dirname, "allowlist.json"), "utf8")
);

const WRITE_ISH_KEYS = new Set([
  "content_write",
  "ingest",
  "delete",
  "delete_id",
  "path_write",
  "overwrite",
  "mutate",
  "create",
  "update",
  "remove",
]);

const TOOL_DEFS = [
  {
    name: "knowledge_list_sources",
    description:
      "List allowlisted knowledge sources. Optional learner_id is accepted but ignored in mock.",
    inputSchema: {
      type: "object",
      properties: {
        learner_id: { type: "string", description: "Optional learner id (ignored in mock)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_search",
    description:
      "Search allowlisted chunks by substring over title+content. Returns hits with citations.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query (min trim length 2)." },
        source_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional filter to these source ids.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 5,
          description: "Max hits (default 5, max 20).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_get",
    description: "Get a chunk by chunk_id, or first/full chunk for a source_id.",
    inputSchema: {
      type: "object",
      properties: {
        chunk_id: { type: "string" },
        source_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function sourceById(id) {
  return allowlist.sources.find((s) => s.id === id);
}

function isAllowlistedSourceId(id) {
  return Boolean(sourceById(id));
}

function isAllowlistedUri(uri) {
  return allowlist.sources.some((s) => s.uri === uri);
}

function softError(code, message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: true, code, message }) }],
    isError: true,
  };
}

function okResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
  };
}

function hasWriteIshArgs(args) {
  if (!args || typeof args !== "object") return false;
  for (const key of Object.keys(args)) {
    if (WRITE_ISH_KEYS.has(key)) return true;
    const lower = key.toLowerCase();
    if (
      lower.includes("ingest") ||
      lower.includes("delete") ||
      lower === "write" ||
      lower.endsWith("_write")
    ) {
      return true;
    }
  }
  return false;
}

function makeCitation(chunk) {
  const src = sourceById(chunk.source_id);
  return {
    source_id: chunk.source_id,
    title: src ? src.title : chunk.title,
    locator: chunk.locator,
  };
}

function listSources(_args) {
  return okResult({
    sources: allowlist.sources.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      uri: s.uri,
      tags: s.tags,
    })),
  });
}

function search(args) {
  if (!args || typeof args.query !== "string") {
    return softError("INVALID_ARGS", "query (string) is required");
  }
  const query = args.query.trim();
  if (query.length < 2) {
    return softError("QUERY_TOO_SHORT", "query trim length must be >= 2");
  }

  let limit = 5;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isFinite(args.limit)) {
      return softError("INVALID_ARGS", "limit must be a number");
    }
    limit = Math.min(20, Math.max(1, Math.floor(args.limit)));
  }

  let sourceFilter = null;
  if (args.source_ids !== undefined) {
    if (!Array.isArray(args.source_ids)) {
      return softError("INVALID_ARGS", "source_ids must be an array of strings");
    }
    for (const sid of args.source_ids) {
      if (typeof sid !== "string") {
        return softError("INVALID_ARGS", "source_ids must be strings");
      }
      if (!isAllowlistedSourceId(sid)) {
        return softError("NOT_IN_ALLOWLIST", `source_id not in allowlist: ${sid}`);
      }
    }
    sourceFilter = new Set(args.source_ids);
  }

  // Reject path/uri args outside allowlist if present
  if (args.uri && typeof args.uri === "string" && !isAllowlistedUri(args.uri)) {
    return softError("NOT_IN_ALLOWLIST", `uri not in allowlist: ${args.uri}`);
  }
  if (args.path && typeof args.path === "string") {
    return softError("NOT_IN_ALLOWLIST", `path not in allowlist: ${args.path}`);
  }

  const q = query.toLowerCase();
  const hits = [];

  for (const chunk of allowlist.chunks) {
    if (sourceFilter && !sourceFilter.has(chunk.source_id)) continue;
    if (!isAllowlistedSourceId(chunk.source_id)) continue;

    const hay = `${chunk.title}\n${chunk.content}`.toLowerCase();
    if (!hay.includes(q)) continue;

    // Hit density heuristic: occurrences / length, plus title bonus
    let count = 0;
    let idx = 0;
    while ((idx = hay.indexOf(q, idx)) !== -1) {
      count += 1;
      idx += q.length;
    }
    const density = count / Math.max(hay.length, 1);
    const titleBonus = chunk.title.toLowerCase().includes(q) ? 0.5 : 0;
    const score = Math.min(1, density * 200 + titleBonus + count * 0.1);

    const snippetStart = Math.max(0, hay.indexOf(q) - 20);
    const snippet = chunk.content.slice(
      Math.min(snippetStart, Math.max(0, chunk.content.length - 120)),
      Math.min(chunk.content.length, snippetStart + 120)
    );

    hits.push({
      chunk_id: chunk.chunk_id,
      source_id: chunk.source_id,
      title: chunk.title,
      snippet,
      score: Math.round(score * 1000) / 1000,
      citation: makeCitation(chunk),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return okResult({ hits: hits.slice(0, limit) });
}

function get(args) {
  if (!args || typeof args !== "object") {
    return softError("INVALID_ARGS", "chunk_id or source_id required");
  }
  if (args.uri && typeof args.uri === "string" && !isAllowlistedUri(args.uri)) {
    return softError("NOT_IN_ALLOWLIST", `uri not in allowlist: ${args.uri}`);
  }
  if (args.path && typeof args.path === "string") {
    return softError("NOT_IN_ALLOWLIST", `path not in allowlist: ${args.path}`);
  }

  const { chunk_id, source_id } = args;
  if (!chunk_id && !source_id) {
    return softError("INVALID_ARGS", "provide chunk_id or source_id");
  }
  if (chunk_id !== undefined && typeof chunk_id !== "string") {
    return softError("INVALID_ARGS", "chunk_id must be a string");
  }
  if (source_id !== undefined && typeof source_id !== "string") {
    return softError("INVALID_ARGS", "source_id must be a string");
  }

  let chunk = null;
  if (chunk_id) {
    chunk = allowlist.chunks.find((c) => c.chunk_id === chunk_id);
    if (!chunk) {
      return softError("NOT_FOUND", `chunk_id not found: ${chunk_id}`);
    }
  } else {
    if (!isAllowlistedSourceId(source_id)) {
      return softError("NOT_IN_ALLOWLIST", `source_id not in allowlist: ${source_id}`);
    }
    chunk = allowlist.chunks.find((c) => c.source_id === source_id);
    if (!chunk) {
      return softError("NOT_FOUND", `no chunks for source_id: ${source_id}`);
    }
  }

  if (!isAllowlistedSourceId(chunk.source_id)) {
    return softError("NOT_IN_ALLOWLIST", `source_id not in allowlist: ${chunk.source_id}`);
  }

  return okResult({
    chunk_id: chunk.chunk_id,
    source_id: chunk.source_id,
    title: chunk.title,
    content: chunk.content,
    citation: makeCitation(chunk),
  });
}

function callTool(name, args) {
  if (hasWriteIshArgs(args)) {
    return softError("FORBIDDEN_WRITE", "write-ish arguments are not allowed");
  }
  switch (name) {
    case "knowledge_list_sources":
      return listSources(args || {});
    case "knowledge_search":
      return search(args || {});
    case "knowledge_get":
      return get(args || {});
    default:
      return softError("INVALID_ARGS", `unknown tool: ${name}`);
  }
}

// --- JSON-RPC / MCP stdio framing ---

let buffer = Buffer.alloc(0);

function sendMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  // Notifications (no id)
  if (msg.method && msg.id === undefined) {
    if (msg.method === "notifications/initialized") {
      return;
    }
    return;
  }

  if (!msg.method) return;

  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "deep-tutor-knowledge", version: "0.1.0" },
        },
      });
      return;
    }

    if (method === "tools/list") {
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: { tools: TOOL_DEFS },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (!toolName || typeof toolName !== "string") {
        sendMessage({
          jsonrpc: "2.0",
          id,
          result: softError("INVALID_ARGS", "tools/call requires name"),
        });
        return;
      }
      const result = callTool(toolName, args);
      sendMessage({ jsonrpc: "2.0", id, result });
      return;
    }

    if (method === "ping") {
      sendMessage({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    sendMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    sendMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(err?.message || err) },
    });
  }
}

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Discard garbage until next potential header
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;

    const body = buffer.slice(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.slice(bodyStart + length);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    handleMessage(msg);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});

process.stdin.resume();
