#!/usr/bin/env node
/**
 * Smoke: spawn MCP server, initialize, listTools, call tools + error cases.
 * Exit 0 on PASS, 1 on FAIL. Prints one-line summary.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const serverPath = join(root, "server", "index.mjs");

function fail(msg) {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
}

function send(child, msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function readMessages(child, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const messages = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${count} message(s), got ${messages.length}`));
    }, timeoutMs);

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buf.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buf = buf.slice(headerEnd + 4);
          continue;
        }
        const length = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buf.length < bodyStart + length) break;
        const body = buf.slice(bodyStart, bodyStart + length).toString("utf8");
        buf = buf.slice(bodyStart + length);
        try {
          messages.push(JSON.parse(body));
        } catch (e) {
          cleanup();
          reject(e);
          return;
        }
        if (messages.length >= count) {
          cleanup();
          resolve(messages);
          return;
        }
      }
    }

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    }

    child.stdout.on("data", onData);
  });
}

function parseToolPayload(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return { raw: result };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main() {
  const child = spawn("node", [serverPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };

  try {
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.3.0" },
      },
    });
    const [initRes] = await readMessages(child, 1);
    if (!initRes.result?.serverInfo?.name) {
      fail(`initialize missing serverInfo: ${JSON.stringify(initRes)}`);
    }

    send(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const [listRes] = await readMessages(child, 1);
    const names = (listRes.result?.tools || []).map((t) => t.name).sort();
    const expected = [
      "knowledge_domain_counts",
      "knowledge_get",
      "knowledge_graph_neighbors",
      "knowledge_graph_snapshot",
      "knowledge_list_sources",
      "knowledge_search",
    ];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      fail(`tools/list expected ${expected.join(",")} got ${names.join(",")}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "knowledge_list_sources", arguments: { learner_id: "smoke" } },
    });
    const [listSrcRes] = await readMessages(child, 1);
    const listPayload = parseToolPayload(listSrcRes.result);
    if (!Array.isArray(listPayload.sources) || listPayload.sources.length < 1) {
      fail(`knowledge_list_sources expected ≥1 source: ${JSON.stringify(listPayload)}`);
    }
    if (typeof listPayload.sources[0].path !== "string" || !listPayload.sources[0].path) {
      fail(`source.path missing: ${JSON.stringify(listPayload.sources[0])}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "knowledge_search", arguments: { query: "费曼", limit: 5 } },
    });
    const [searchRes] = await readMessages(child, 1);
    const searchPayload = parseToolPayload(searchRes.result);
    if (!Array.isArray(searchPayload.hits) || searchPayload.hits.length < 1) {
      fail(`knowledge_search expected ≥1 hit: ${JSON.stringify(searchPayload)}`);
    }
    const hit = searchPayload.hits[0];
    if (!hit.citation || !hit.citation.source_id || !hit.citation.locator || !hit.citation.path) {
      fail(`knowledge_search hit missing citation.path: ${JSON.stringify(hit)}`);
    }
    if (typeof hit.path !== "string" || !hit.path) {
      fail(`hit.path missing: ${JSON.stringify(hit)}`);
    }
    const chunkId = hit.chunk_id;

    send(child, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "knowledge_get", arguments: { chunk_id: chunkId } },
    });
    const [getRes] = await readMessages(child, 1);
    const getPayload = parseToolPayload(getRes.result);
    if (!getPayload.content || String(getPayload.content).length < 1) {
      fail(`knowledge_get expected non-empty content: ${JSON.stringify(getPayload)}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "knowledge_domain_counts",
        arguments: { domains: ["methods", "concepts"] },
      },
    });
    const [countsRes] = await readMessages(child, 1);
    const countsPayload = parseToolPayload(countsRes.result);
    if (!Array.isArray(countsPayload.counts) || countsPayload.counts.length < 2) {
      fail(`domain_counts expected methods+concepts: ${JSON.stringify(countsPayload)}`);
    }
    const byDomain = Object.fromEntries(
      countsPayload.counts.map((c) => [c.domain, c])
    );
    if (!byDomain.methods || byDomain.methods.items < 1) {
      fail(`methods items≥1: ${JSON.stringify(countsPayload)}`);
    }
    if (!byDomain.concepts || byDomain.concepts.items < 1) {
      fail(`concepts items≥1: ${JSON.stringify(countsPayload)}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "knowledge_search", arguments: { query: "x" } },
    });
    const [shortRes] = await readMessages(child, 1);
    const shortPayload = parseToolPayload(shortRes.result);
    if (shortPayload.code !== "QUERY_TOO_SHORT") {
      fail(`expected QUERY_TOO_SHORT got ${shortPayload.code}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "knowledge_get",
        arguments: { chunk_id: "chk-does-not-exist" },
      },
    });
    const [nfRes] = await readMessages(child, 1);
    const nfPayload = parseToolPayload(nfRes.result);
    if (nfPayload.code !== "NOT_FOUND") {
      fail(`expected NOT_FOUND: ${JSON.stringify(nfPayload)}`);
    }

    // Path outside whitelist → NOT_IN_ALLOWLIST
    send(child, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "knowledge_get",
        arguments: { source_id: "methods/../../etc/passwd" },
      },
    });
    const [travRes] = await readMessages(child, 1);
    const travPayload = parseToolPayload(travRes.result);
    if (travPayload.code !== "NOT_IN_ALLOWLIST") {
      fail(`expected NOT_IN_ALLOWLIST for traversal: ${JSON.stringify(travPayload)}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "knowledge_search",
        arguments: { query: "惯性", path: "/etc/passwd" },
      },
    });
    const [pathRes] = await readMessages(child, 1);
    const pathPayload = parseToolPayload(pathRes.result);
    if (pathPayload.code !== "NOT_IN_ALLOWLIST") {
      fail(`expected NOT_IN_ALLOWLIST for path: ${JSON.stringify(pathPayload)}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "knowledge_graph_snapshot",
        arguments: { mode: "all", top_n: 8, limit_nodes: 80 },
      },
    });
    const [graphRes] = await readMessages(child, 1);
    const graphPayload = parseToolPayload(graphRes.result);
    if (!Array.isArray(graphPayload.nodes) || !Array.isArray(graphPayload.edges)) {
      fail(`graph_snapshot missing nodes/edges: ${JSON.stringify(graphPayload)}`);
    }
    if (!Array.isArray(graphPayload.topConnected) || !Array.isArray(graphPayload.topConcepts)) {
      fail(`graph_snapshot missing top*: ${JSON.stringify(graphPayload)}`);
    }
    for (const n of graphPayload.nodes) {
      for (const k of ["id", "title", "shelf", "path", "weight"]) {
        if (n[k] === undefined) fail(`node missing ${k}: ${JSON.stringify(n)}`);
      }
    }
    for (const e of graphPayload.edges) {
      for (const k of ["from", "to", "kind", "weight"]) {
        if (e[k] === undefined) fail(`edge missing ${k}: ${JSON.stringify(e)}`);
      }
      if (!["link", "mutual", "unresolved"].includes(e.kind)) {
        fail(`bad edge kind: ${e.kind}`);
      }
    }
    const mutual = graphPayload.edges.filter((e) => e.kind === "mutual");
    const links = graphPayload.edges.filter((e) => e.kind === "link" || e.kind === "mutual");
    if (graphPayload.nodes.length < 1) fail("expected ≥1 node");
    // sample data has real wikilinks — expect at least one resolved edge
    if (links.length < 1) {
      fail(`expected ≥1 resolved edge from sample wikilinks: ${JSON.stringify(graphPayload.edges)}`);
    }
    if (mutual.length < 1) {
      fail(`expected ≥1 mutual (费曼复述↔费曼一轮): ${JSON.stringify(graphPayload.edges)}`);
    }
    for (const row of graphPayload.topConnected) {
      for (const k of ["from_title", "to_title", "from_path", "to_path", "kind", "weight"]) {
        if (row[k] === undefined) fail(`topConnected missing ${k}`);
      }
    }
    for (const row of graphPayload.topConcepts) {
      for (const k of ["title", "mentions", "path"]) {
        if (row[k] === undefined) fail(`topConcepts missing ${k}`);
      }
    }

    // empty-domain / empty filter honesty: unresolved-only may be empty array (ok)
    send(child, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "knowledge_graph_snapshot",
        arguments: { mode: "unresolved", domains: ["concepts"] },
      },
    });
    const [unRes] = await readMessages(child, 1);
    const unPayload = parseToolPayload(unRes.result);
    if (!Array.isArray(unPayload.edges) || unPayload.topConnected === undefined) {
      fail(`unresolved mode shape: ${JSON.stringify(unPayload)}`);
    }
    // must not invent: if empty, edges === []
    if (unPayload.edges.length === 0 && unPayload.topConnected.length !== 0) {
      fail("empty unresolved must not invent topConnected");
    }

    send(child, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "knowledge_graph_neighbors",
        arguments: { node_id: "methods/费曼一轮.md", kind: "all", limit: 12 },
      },
    });
    const [nbRes] = await readMessages(child, 1);
    const nbPayload = parseToolPayload(nbRes.result);
    if (!nbPayload.node || !Array.isArray(nbPayload.neighbors)) {
      fail(`neighbors shape: ${JSON.stringify(nbPayload)}`);
    }
    if (nbPayload.neighbors.length < 1) {
      fail(`费曼一轮 should have neighbors: ${JSON.stringify(nbPayload)}`);
    }

    send(child, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "knowledge_graph_neighbors",
        arguments: { node_id: "methods/does-not-exist.md" },
      },
    });
    const [nbNf] = await readMessages(child, 1);
    const nbNfPayload = parseToolPayload(nbNf.result);
    if (nbNfPayload.code !== "NOT_FOUND") {
      fail(`neighbors NOT_FOUND: ${JSON.stringify(nbNfPayload)}`);
    }

    kill();
    console.log(
      "PASS: initialize + 6 tools + graph_snapshot(nodes=" +
        graphPayload.nodes.length +
        ",edges=" +
        graphPayload.edges.length +
        ",mutual=" +
        mutual.length +
        ") + neighbors + soft errors (sources=" +
        listPayload.sources.length +
        ", hits=" +
        searchPayload.hits.length +
        ", methods=" +
        byDomain.methods.items +
        ", concepts=" +
        byDomain.concepts.items +
        ")"
    );
    process.exit(0);
  } catch (err) {
    kill();
    fail(`${err.message}${stderr ? " stderr=" + stderr.slice(0, 200) : ""}`);
  }
}

main();
