/**
 * Read-only graph derived from whitelist [[wikilinks]].
 * Empty edges → empty arrays (never invent).
 */
import {
  loadWhitelist,
  softError,
  hasWriteIshArgs,
  collectSources,
  readSourceFile,
  countMentions,
} from "./knowledge.mjs";

const WIKI_RE = /\[\[([^\]\n]+)\]\]/g;
const DEFAULT_DOMAINS = ["concepts", "methods"];

function clampInt(n, lo, hi, fallback) {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function parseWikilinks(text) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(WIKI_RE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    // drop alias after |
    const target = raw.split("|")[0].trim();
    if (target) out.push(target);
  }
  return out;
}

function resolveTarget(sources, token) {
  const t = token.trim();
  if (!t) return null;
  const byId = sources.find(
    (s) => s.source_id === t || s.source_id.endsWith("/" + t) || s.relPath === t
  );
  if (byId) return byId;
  const byTitle = sources.find((s) => s.title === t);
  if (byTitle) return byTitle;
  // title without extension
  const bare = t.replace(/\.(md|txt|ya?ml|json)$/i, "");
  return sources.find((s) => s.title === bare) || null;
}

function buildRawGraph(config, domainSet) {
  const all = collectSources(config);
  const sources = all.filter((s) => domainSet.has(s.rootId));
  const byId = new Map(sources.map((s) => [s.source_id, s]));

  /** @type {Map<string, {from:string,to:string,kind:string,weight:number,label?:string}>} */
  const linkKey = new Map();
  const unresolved = [];

  for (const src of sources) {
    const body = readSourceFile(config, src);
    if (body === null) continue;
    for (const token of parseWikilinks(body)) {
      const target = resolveTarget(sources, token);
      if (!target) {
        unresolved.push({
          from: src.source_id,
          to: `unresolved:${token}`,
          kind: "unresolved",
          weight: 1,
          label: token,
        });
        continue;
      }
      if (target.source_id === src.source_id) continue;
      const key = `${src.source_id}=>${target.source_id}`;
      const prev = linkKey.get(key);
      if (prev) prev.weight += 1;
      else
        linkKey.set(key, {
          from: src.source_id,
          to: target.source_id,
          kind: "link",
          weight: 1,
        });
    }
  }

  // promote mutual
  for (const [key, e] of [...linkKey.entries()]) {
    if (e.kind !== "link") continue;
    const rev = `${e.to}=>${e.from}`;
    if (linkKey.has(rev)) {
      e.kind = "mutual";
      const other = linkKey.get(rev);
      if (other && other.kind === "link") other.kind = "mutual";
    }
  }

  const edges = [...linkKey.values(), ...unresolved];

  // degree weights
  const degree = new Map();
  for (const e of edges) {
    if (e.kind === "unresolved") {
      degree.set(e.from, (degree.get(e.from) || 0) + e.weight);
      continue;
    }
    degree.set(e.from, (degree.get(e.from) || 0) + e.weight);
    degree.set(e.to, (degree.get(e.to) || 0) + e.weight);
  }

  const corpora = [];
  for (const s of sources) {
    const c = readSourceFile(config, s);
    if (c !== null) corpora.push(c);
  }
  const conceptTitles = sources.filter((s) => s.rootId === "concepts").map((s) => s.title);

  const nodes = sources.map((s) => {
    let weight = degree.get(s.source_id) || 0;
    if (s.rootId === "concepts") {
      weight += countMentions([s.title], corpora);
    }
    return {
      id: s.source_id,
      title: s.title,
      shelf: s.rootId,
      path: s.source_id,
      weight,
    };
  });

  return { nodes, edges, byId, sources, corpora, conceptTitles };
}

function filterEdges(edges, mode) {
  if (!mode || mode === "all" || mode === "links") {
    // "links" bar shows link+mutual typically; unresolved separate
    if (mode === "links") return edges.filter((e) => e.kind === "link" || e.kind === "mutual");
    return edges;
  }
  if (mode === "mutual") return edges.filter((e) => e.kind === "mutual");
  if (mode === "unresolved") return edges.filter((e) => e.kind === "unresolved");
  return edges;
}

function buildTopConnected(edges, byId, topN) {
  const ranked = edges
    .filter((e) => e.kind === "link" || e.kind === "mutual")
    .slice()
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from, "zh"));
  const out = [];
  for (const e of ranked) {
    if (out.length >= topN) break;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    out.push({
      from_id: e.from,
      to_id: e.to,
      from_title: from.title,
      to_title: to.title,
      from_path: from.source_id,
      to_path: to.source_id,
      kind: e.kind === "mutual" ? "mutual" : "link",
      weight: e.weight,
    });
  }
  return out;
}

function buildTopConcepts(nodes, topN) {
  return nodes
    .filter((n) => n.shelf === "concepts")
    .slice()
    .sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title, "zh"))
    .slice(0, topN)
    .map((n) => ({
      id: n.id,
      title: n.title,
      mentions: Math.max(0, Math.round(n.weight)),
      path: n.path,
      weight: n.weight,
    }));
}

export function graphSnapshot(wl, args = {}) {
  const config = wl || loadWhitelist();
  if (hasWriteIshArgs(args)) {
    return softError("FORBIDDEN_WRITE", "write-ish arguments are not allowed");
  }

  let domains = DEFAULT_DOMAINS;
  if (args.domains !== undefined) {
    if (!Array.isArray(args.domains) || !args.domains.every((d) => typeof d === "string")) {
      return softError("INVALID_ARGS", "domains must be an array of strings");
    }
    domains = args.domains;
  }
  const domainSet = new Set(domains);
  const mode = typeof args.mode === "string" ? args.mode : "all";
  if (!["links", "mutual", "unresolved", "all"].includes(mode)) {
    return softError("INVALID_ARGS", "mode must be links|mutual|unresolved|all");
  }
  const limit_nodes = clampInt(args.limit_nodes, 1, 80, 80);
  const limit_edges = clampInt(args.limit_edges, 0, 400, 200);
  const top_n = clampInt(args.top_n, 1, 20, 8);

  const raw = buildRawGraph(config, domainSet);
  let nodes = raw.nodes.slice().sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id, "zh"));
  nodes = nodes.slice(0, limit_nodes);
  const nodeIds = new Set(nodes.map((n) => n.id));

  let edges = filterEdges(raw.edges, mode).filter((e) => {
    if (e.kind === "unresolved") return nodeIds.has(e.from);
    return nodeIds.has(e.from) && nodeIds.has(e.to);
  });
  edges = edges
    .slice()
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from, "zh"))
    .slice(0, limit_edges);

  const byId = raw.byId;
  const topConnected =
    mode === "unresolved" ? [] : buildTopConnected(edges, byId, top_n);
  const topConcepts = buildTopConcepts(nodes, top_n);

  return { nodes, edges, topConnected, topConcepts };
}

export function graphNeighbors(wl, args = {}) {
  const config = wl || loadWhitelist();
  if (hasWriteIshArgs(args)) {
    return softError("FORBIDDEN_WRITE", "write-ish arguments are not allowed");
  }
  if (!args || typeof args.node_id !== "string" || !args.node_id) {
    return softError("INVALID_ARGS", "node_id (string) is required");
  }
  const kind = typeof args.kind === "string" ? args.kind : "all";
  if (!["link", "mutual", "unresolved", "all"].includes(kind)) {
    return softError("INVALID_ARGS", "kind must be link|mutual|unresolved|all");
  }
  const limit = clampInt(args.limit, 1, 40, 12);

  const snap = graphSnapshot(config, { mode: "all", limit_nodes: 80, limit_edges: 400, top_n: 8 });
  if (snap.error) return snap;
  const node = snap.nodes.find((n) => n.id === args.node_id);
  if (!node) return softError("NOT_FOUND", `node_id not found: ${args.node_id}`);

  const neighbors = [];
  for (const e of snap.edges) {
    if (kind !== "all" && e.kind !== kind) continue;
    let other = null;
    let edgeKind = e.kind;
    if (e.from === args.node_id) other = e.to;
    else if (e.to === args.node_id && e.kind !== "unresolved") other = e.from;
    else continue;
    if (e.kind === "unresolved" && e.from === args.node_id) {
      neighbors.push({
        id: e.to,
        title: e.label || e.to.replace(/^unresolved:/, ""),
        path: "",
        kind: "unresolved",
        weight: e.weight,
      });
      continue;
    }
    const n = snap.nodes.find((x) => x.id === other);
    if (!n) continue;
    neighbors.push({
      id: n.id,
      title: n.title,
      path: n.path,
      kind: edgeKind,
      weight: e.weight,
    });
  }
  neighbors.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title, "zh"));
  return { node, neighbors: neighbors.slice(0, limit) };
}
