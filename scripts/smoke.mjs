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
        clientInfo: { name: "smoke", version: "0.2.0" },
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
    if (!hit.citation || !hit.citation.source_id || !hit.citation.locator) {
      fail(`knowledge_search hit missing citation: ${JSON.stringify(hit)}`);
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

    kill();
    console.log(
      "PASS: initialize + 4 tools + domain_counts + QUERY_TOO_SHORT + NOT_FOUND + NOT_IN_ALLOWLIST (sources=" +
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
