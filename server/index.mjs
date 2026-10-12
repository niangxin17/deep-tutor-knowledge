#!/usr/bin/env node
/**
 * Zero-dep MCP stdio server for deep-tutor-knowledge.
 * Thin Content-Length JSON-RPC wrapper over knowledge.mjs + graph.mjs.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadWhitelist,
  listSources,
  search,
  get,
  domainCounts,
} from "./lib/knowledge.mjs";
import { graphSnapshot, graphNeighbors } from "./lib/graph.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wl = loadWhitelist(__dirname);

const TOOL_DEFS = [
  {
    name: "knowledge_list_sources",
    description:
      "List allowlisted knowledge files under whitelist roots. Optional learner_id is accepted but ignored.",
    inputSchema: {
      type: "object",
      properties: {
        learner_id: {
          type: "string",
          description: "Optional learner id (ignored).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_search",
    description:
      "Search allowlisted file contents by substring over title+content. Returns hits with citations.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query (min trim length 2)." },
        source_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional filter to these source ids (e.g. methods/foo.md).",
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
    description:
      "Get file content by chunk_id (source_id#full) or source_id. Read-only whitelist only.",
    inputSchema: {
      type: "object",
      properties: {
        chunk_id: { type: "string" },
        source_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_domain_counts",
    description:
      "Count allowlisted files per domain root (methods/concepts) for /studio cards. Heuristics: wikilinks=[[...]] in methods; mentions=concept-title occurrences across files.",
    inputSchema: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domain ids (default: all whitelist roots).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_graph_snapshot",
    description:
      "Whitelist-derived graph for studio Links/Mutual/Unresolved. Edges from [[wikilinks]]; empty edges → honest empty, no fabrications.",
    inputSchema: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "string" },
          description: 'Default ["concepts","methods"].',
        },
        mode: {
          type: "string",
          enum: ["links", "mutual", "unresolved", "all"],
          description: "Filter edge kinds; default all.",
        },
        limit_nodes: { type: "integer", minimum: 1, maximum: 80, default: 80 },
        limit_edges: { type: "integer", minimum: 0, maximum: 400, default: 200 },
        top_n: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_graph_neighbors",
    description:
      "Neighbors of one node for tooltip / Mutual filter. Same allowlist; no invent.",
    inputSchema: {
      type: "object",
      required: ["node_id"],
      properties: {
        node_id: { type: "string" },
        kind: {
          type: "string",
          enum: ["link", "mutual", "unresolved", "all"],
          default: "all",
        },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 12 },
      },
      additionalProperties: false,
    },
  },
];

function softErrorResult(code, message) {
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

function wrap(result) {
  if (result && result.error === true) {
    return softErrorResult(result.code, result.message);
  }
  return okResult(result);
}

function callTool(name, args) {
  switch (name) {
    case "knowledge_list_sources":
      return wrap(listSources(wl, args || {}));
    case "knowledge_search":
      return wrap(search(wl, args || {}));
    case "knowledge_get":
      return wrap(get(wl, args || {}));
    case "knowledge_domain_counts":
      return wrap(domainCounts(wl, args || {}));
    case "knowledge_graph_snapshot":
      return wrap(graphSnapshot(wl, args || {}));
    case "knowledge_graph_neighbors":
      return wrap(graphNeighbors(wl, args || {}));
    default:
      return softErrorResult("INVALID_ARGS", `unknown tool: ${name}`);
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

  if (msg.method && msg.id === undefined) {
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
          serverInfo: { name: "deep-tutor-knowledge", version: "0.3.0" },
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
          result: softErrorResult("INVALID_ARGS", "tools/call requires name"),
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
