/**
 * Whitelist read-only knowledge helpers (list/search/get/domainCounts).
 * Used by the MCP stdio server; copy or import into deep-tutor for /studio counts.
 * Zero deps. Field names frozen to tools.schema.json.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_WHITELIST_NAME = "whitelist.json";

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

/**
 * @param {string} [serverDir] directory containing whitelist.json (default: ../ relative to this file)
 * @param {string} [whitelistPath] absolute path override; else env KNOWLEDGE_WHITELIST
 */
export function loadWhitelist(serverDir, whitelistPath) {
  const dir = serverDir
    ? resolve(serverDir)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = process.env.KNOWLEDGE_WHITELIST;
  const wlFile = whitelistPath
    ? resolve(whitelistPath)
    : envPath
      ? resolve(envPath)
      : join(dir, DEFAULT_WHITELIST_NAME);

  if (!existsSync(wlFile)) {
    throw new Error(`whitelist not found: ${wlFile}`);
  }

  const raw = JSON.parse(readFileSync(wlFile, "utf8"));
  const wlDir = dirname(wlFile);
  const extensions = Array.isArray(raw.extensions)
    ? raw.extensions.map((e) =>
        String(e).startsWith(".") ? String(e).toLowerCase() : `.${String(e).toLowerCase()}`
      )
    : [".md", ".txt", ".yaml", ".yml", ".json"];
  const maxFileBytes =
    typeof raw.max_file_bytes === "number" && raw.max_file_bytes > 0
      ? raw.max_file_bytes
      : 200000;

  const roots = [];
  for (const r of raw.roots || []) {
    if (!r || typeof r.id !== "string" || typeof r.path !== "string") continue;
    roots.push({
      id: r.id,
      title: typeof r.title === "string" ? r.title : r.id,
      kind: typeof r.kind === "string" ? r.kind : "file",
      path: r.path,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      absPath: resolve(wlDir, r.path),
    });
  }

  return { wlFile, wlDir, roots, extensions, maxFileBytes };
}

export function softError(code, message) {
  return { error: true, code, message };
}

export function hasWriteIshArgs(args) {
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

/** candidateAbs must resolve inside rootAbs (realpath when possible). */
export function isInsideRoot(rootAbs, candidateAbs) {
  let rootReal = resolve(rootAbs);
  let candReal = resolve(candidateAbs);
  try {
    if (existsSync(rootReal)) rootReal = realpathSync(rootReal);
  } catch {
    /* keep */
  }
  try {
    if (existsSync(candReal)) candReal = realpathSync(candReal);
  } catch {
    /* keep */
  }
  const rel = relative(rootReal, candReal);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return true;
}

function listFilesInRoot(wl, root) {
  const out = [];
  if (!existsSync(root.absPath)) return out;
  let rootStat;
  try {
    rootStat = statSync(root.absPath);
  } catch {
    return out;
  }
  if (!rootStat.isDirectory()) return out;

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === "." || ent.name === "..") continue;
      const full = join(dir, ent.name);
      if (!isInsideRoot(root.absPath, full)) continue;
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = extname(ent.name).toLowerCase();
      if (!wl.extensions.includes(ext)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > wl.maxFileBytes) continue;
      const relInRoot = relative(root.absPath, full).split(sep).join("/");
      if (
        !relInRoot ||
        relInRoot.includes("..") ||
        relInRoot.startsWith("/") ||
        relInRoot.includes("\0")
      ) {
        continue;
      }
      const source_id = `${root.id}/${relInRoot}`;
      const titleFromName = ent.name.replace(/\.[^.]+$/, "");
      out.push({
        source_id,
        title: titleFromName,
        kind: "file",
        uri: pathToFileURL(full).href,
        tags: [...root.tags],
        absPath: full,
        relPath: relInRoot,
        rootId: root.id,
      });
    }
  }

  walk(root.absPath);
  out.sort((a, b) => a.source_id.localeCompare(b.source_id, "zh"));
  return out;
}

export function collectSources(wl) {
  const sources = [];
  for (const root of wl.roots) {
    sources.push(...listFilesInRoot(wl, root));
  }
  return sources;
}

function readSourceFile(wl, source) {
  const root = wl.roots.find((r) => r.id === source.rootId);
  if (!root || !isInsideRoot(root.absPath, source.absPath)) return null;
  try {
    const st = statSync(source.absPath);
    if (st.size > wl.maxFileBytes) return null;
    return readFileSync(source.absPath, "utf8");
  } catch {
    return null;
  }
}

function makeCitation(source, locator = "full") {
  return {
    source_id: source.source_id,
    title: source.title,
    locator,
    path: source.source_id,
  };
}

function rejectOutsidePathOrUri(args, sources) {
  if (!args || typeof args !== "object") return null;

  if (typeof args.path === "string") {
    const p = args.path;
    if (p.includes("..") || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) {
      const hit = sources.find(
        (s) =>
          s.absPath === resolve(p) ||
          s.source_id === p ||
          s.uri === p ||
          s.uri === pathToFileURL(resolve(p)).href
      );
      if (!hit) return softError("NOT_IN_ALLOWLIST", `path not in allowlist: ${p}`);
    } else {
      const hit = sources.find(
        (s) => s.source_id === p || s.relPath === p || s.absPath === resolve(p)
      );
      if (!hit) return softError("NOT_IN_ALLOWLIST", `path not in allowlist: ${p}`);
    }
  }

  if (typeof args.uri === "string") {
    const u = args.uri;
    const hit = sources.find((s) => s.uri === u);
    if (!hit) return softError("NOT_IN_ALLOWLIST", `uri not in allowlist: ${u}`);
  }

  return null;
}

function looksLikeTraversal(id) {
  return (
    typeof id === "string" &&
    (id.includes("..") ||
      id.includes("\0") ||
      id.startsWith("/") ||
      id.includes("\\") ||
      /^[A-Za-z]:[\\/]/.test(id))
  );
}

export function listSources(wl, args = {}) {
  const config = wl || loadWhitelist();
  if (hasWriteIshArgs(args)) {
    return softError("FORBIDDEN_WRITE", "write-ish arguments are not allowed");
  }
  const sources = collectSources(config);
  const blocked = rejectOutsidePathOrUri(args, sources);
  if (blocked) return blocked;

  return {
    sources: sources.map((s) => ({
      id: s.source_id,
      title: s.title,
      kind: s.kind,
      uri: s.uri,
      tags: s.tags,
      path: s.source_id,
    })),
  };
}

export function search(wl, args = {}) {
  const config = wl || loadWhitelist();
  if (hasWriteIshArgs(args)) {
    return softError("FORBIDDEN_WRITE", "write-ish arguments are not allowed");
  }
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

  const sources = collectSources(config);
  const blocked = rejectOutsidePathOrUri(args, sources);
  if (blocked) return blocked;

  let sourceFilter = null;
  if (args.source_ids !== undefined) {
    if (!Array.isArray(args.source_ids)) {
      return softError("INVALID_ARGS", "source_ids must be an array of strings");
    }
    for (const sid of args.source_ids) {
      if (typeof sid !== "string") {
        return softError("INVALID_ARGS", "source_ids must be strings");
      }
      if (!sources.some((s) => s.source_id === sid)) {
        return softError("NOT_IN_ALLOWLIST", `source_id not in allowlist: ${sid}`);
      }
    }
    sourceFilter = new Set(args.source_ids);
  }

  const q = query.toLowerCase();
  const hits = [];

  for (const source of sources) {
    if (sourceFilter && !sourceFilter.has(source.source_id)) continue;
    const content = readSourceFile(config, source);
    if (content === null) continue;
    const hay = `${source.title}\n${content}`.toLowerCase();
    if (!hay.includes(q)) continue;

    let count = 0;
    let idx = 0;
    while ((idx = hay.indexOf(q, idx)) !== -1) {
      count += 1;
      idx += q.length;
    }
    const density = count / Math.max(hay.length, 1);
    const titleBonus = source.title.toLowerCase().includes(q) ? 0.5 : 0;
    const score = Math.min(1, density * 200 + titleBonus + count * 0.1);

    const contentLower = content.toLowerCase();
    const at = contentLower.indexOf(q);
    const snippetStart = at >= 0 ? Math.max(0, at - 20) : 0;
    const snippet = content.slice(snippetStart, snippetStart + 120);

    hits.push({
      chunk_id: `${source.source_id}#full`,
      source_id: source.source_id,
      title: source.title,
      snippet,
      score: Math.round(score * 1000) / 1000,
      path: source.source_id,
      citation: makeCitation(source, "full"),
    });
  }

  hits.sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id));
  return { hits: hits.slice(0, limit) };
}

export function get(wl, args = {}) {
  const config = wl || loadWhitelist();
  if (hasWriteIshArgs(args)) {
    return softError("FORBIDDEN_WRITE", "write-ish arguments are not allowed");
  }
  if (!args || typeof args !== "object") {
    return softError("INVALID_ARGS", "chunk_id or source_id required");
  }

  const sources = collectSources(config);
  const blocked = rejectOutsidePathOrUri(args, sources);
  if (blocked) return blocked;

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

  let source = null;
  if (chunk_id) {
    if (looksLikeTraversal(chunk_id)) {
      return softError("NOT_IN_ALLOWLIST", `chunk_id not in allowlist: ${chunk_id}`);
    }
    const sid = chunk_id.includes("#")
      ? chunk_id.slice(0, chunk_id.indexOf("#"))
      : chunk_id;
    source = sources.find((s) => s.source_id === sid);
    if (!source) {
      return softError("NOT_FOUND", `chunk_id not found: ${chunk_id}`);
    }
  } else {
    if (looksLikeTraversal(source_id)) {
      return softError("NOT_IN_ALLOWLIST", `source_id not in allowlist: ${source_id}`);
    }
    source = sources.find((s) => s.source_id === source_id);
    if (!source) {
      return softError("NOT_IN_ALLOWLIST", `source_id not in allowlist: ${source_id}`);
    }
  }

  const content = readSourceFile(config, source);
  if (content === null) {
    return softError("NOT_FOUND", `cannot read source: ${source.source_id}`);
  }

  return {
    chunk_id: `${source.source_id}#full`,
    source_id: source.source_id,
    title: source.title,
    content,
    path: source.source_id,
    citation: makeCitation(source, "full"),
  };
}

/** Count `[[wikilink]]` tokens. */
export function countWikilinks(text) {
  const re = /\[\[([^\]\n]+)\]\]/g;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/**
 * Mentions heuristic: sum of case-sensitive occurrences of each concept title
 * across all allowlisted file bodies (includes headings / wikilink text).
 */
export function countMentions(terms, corpora) {
  let total = 0;
  for (const term of terms) {
    if (!term || term.length < 1) continue;
    for (const body of corpora) {
      let idx = 0;
      while ((idx = body.indexOf(term, idx)) !== -1) {
        total += 1;
        idx += term.length;
      }
    }
  }
  return total;
}

export function domainCounts(wl, args = {}) {
  const config = wl || loadWhitelist();
  if (hasWriteIshArgs(args)) {
    return softError("FORBIDDEN_WRITE", "write-ish arguments are not allowed");
  }

  let domains = config.roots.map((r) => r.id);
  if (args.domains !== undefined) {
    if (!Array.isArray(args.domains)) {
      return softError("INVALID_ARGS", "domains must be an array of strings");
    }
    for (const d of args.domains) {
      if (typeof d !== "string") {
        return softError("INVALID_ARGS", "domains must be strings");
      }
    }
    domains = args.domains;
  }

  const sources = collectSources(config);
  const allContents = [];
  for (const s of sources) {
    const c = readSourceFile(config, s);
    if (c !== null) allContents.push(c);
  }

  const conceptTerms = sources.filter((s) => s.rootId === "concepts").map((s) => s.title);

  const counts = [];
  for (const domain of domains) {
    const root = config.roots.find((r) => r.id === domain);
    const files = root ? sources.filter((s) => s.rootId === domain) : [];
    const items = files.length;

    if (domain === "methods") {
      let wikilinks = 0;
      for (const f of files) {
        const c = readSourceFile(config, f);
        if (c) wikilinks += countWikilinks(c);
      }
      counts.push({ domain, items, extra: { wikilinks } });
    } else if (domain === "concepts") {
      const mentions = countMentions(conceptTerms, allContents);
      counts.push({ domain, items, extra: { mentions } });
    } else {
      counts.push({ domain, items, extra: {} });
    }
  }

  return { counts };
}
