import events from "node:events";

import { Type } from "@sinclair/typebox";

export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_SEARCH_RESULTS = 30;
export const MAX_TOOL_CALLS_TO_KEEP = 80;

const DEFAULT_EVENTTARGET_MAX_LISTENERS = 100;
const EVENTTARGET_MAX_LISTENERS_STATE_KEY = Symbol.for("pi.eventTargetMaxListenersState");

type EventTargetMaxListenersState = { depth: number; savedDefault?: number };

export type LibrarianStatus = "running" | "done" | "error" | "aborted";

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
};

export interface CachedFile {
  repo: string;
  remotePath: string;
  ref?: string;
  sha?: string;
  localPath: string;
  bytes: number;
  lines: number;
  fetchedAt: number;
}

export interface LibrarianRunDetails {
  status: LibrarianStatus;
  query: string;
  turns: number;
  toolCalls: ToolCall[];
  cachedFiles: CachedFile[];
  summaryText?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface LibrarianDetails {
  status: LibrarianStatus;
  workspace?: string;
  subagentProvider?: string;
  subagentModelId?: string;
  runs: LibrarianRunDetails[];
}

export interface GithubCodeSearchResult {
  repository: string;
  path: string;
  sha: string;
  url: string;
  snippets: string[];
}

export const LibrarianParams = Type.Object({
  query: Type.String({
    description: [
      "Describe what to find in GitHub repositories.",
      "Include: target behavior/symbols, any repository scope hints, and desired output.",
      "The librarian should return paths and line ranges, not full file dumps.",
    ].join("\n"),
  }),
  repos: Type.Optional(
    Type.Array(Type.String({ description: "Optional owner/repo filters (e.g. octocat/hello-world)" }), {
      description: "Optional explicit repository scope.",
      maxItems: 30,
    }),
  ),
  owners: Type.Optional(
    Type.Array(Type.String({ description: "Optional owner/org filters" }), {
      description: "Optional owner/org scope.",
      maxItems: 30,
    }),
  ),
  maxSearchResults: Type.Optional(
    Type.Number({
      description: `Maximum GitHub search hits per query (1-100, default ${DEFAULT_MAX_SEARCH_RESULTS})`,
      minimum: 1,
      maximum: 100,
      default: DEFAULT_MAX_SEARCH_RESULTS,
    }),
  ),
  maxTurns: Type.Optional(
    Type.Number({
      description: `Maximum subagent turns (3-20, default ${DEFAULT_MAX_TURNS})`,
      minimum: 3,
      maximum: 20,
      default: DEFAULT_MAX_TURNS,
    }),
  ),
});

export const GithubCodeSearchParams = Type.Object({
  query: Type.String({ description: "GitHub code search query" }),
  repos: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
  owners: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: DEFAULT_MAX_SEARCH_RESULTS })),
  match: Type.Optional(Type.String({ description: 'Optional match filter: "file" or "path"' })),
});

export const GithubFetchFileParams = Type.Object({
  repo: Type.String({ description: "Repository in owner/repo format" }),
  path: Type.String({ description: "Path to file in repository" }),
  ref: Type.Optional(Type.String({ description: "Git ref (branch/tag/commit)" })),
  sha: Type.Optional(Type.String({ description: "Blob SHA for precise fetch" })),
});

function getEventTargetMaxListenersState(): EventTargetMaxListenersState {
  const g = globalThis as any;
  if (!g[EVENTTARGET_MAX_LISTENERS_STATE_KEY]) g[EVENTTARGET_MAX_LISTENERS_STATE_KEY] = { depth: 0 };
  return g[EVENTTARGET_MAX_LISTENERS_STATE_KEY] as EventTargetMaxListenersState;
}

export function bumpDefaultEventTargetMaxListeners(): () => void {
  const state = getEventTargetMaxListenersState();

  const raw = process.env.PI_EVENTTARGET_MAX_LISTENERS ?? process.env.PI_ABORT_MAX_LISTENERS;
  const desired = raw !== undefined ? Number(raw) : DEFAULT_EVENTTARGET_MAX_LISTENERS;
  if (!Number.isFinite(desired) || desired < 0) return () => {};

  if (state.depth === 0) state.savedDefault = events.defaultMaxListeners;
  state.depth += 1;

  if (events.defaultMaxListeners < desired) events.setMaxListeners(desired);

  return () => {
    state.depth = Math.max(0, state.depth - 1);
    if (state.depth !== 0) return;
    if (state.savedDefault === undefined) return;

    events.setMaxListeners(state.savedDefault);
    state.savedDefault = undefined;
  };
}

export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function asStringArray(value: unknown, maxItems = 30): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function getLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const parts = msg.content;
    if (!Array.isArray(parts)) continue;

    const blocks: string[] = [];
    for (const part of parts) {
      if (part?.type === "text" && typeof part.text === "string") blocks.push(part.text);
    }

    if (blocks.length > 0) return blocks.join("");
  }
  return "";
}

export function computeOverallStatus(runs: LibrarianRunDetails[]): LibrarianStatus {
  if (runs.some((r) => r.status === "running")) return "running";
  if (runs.some((r) => r.status === "error")) return "error";
  if (runs.every((r) => r.status === "aborted")) return "aborted";
  return "done";
}

export function renderCombinedMarkdown(runs: LibrarianRunDetails[]): string {
  const r = runs[0];
  return (r.summaryText ?? (r.status === "running" ? "(searching...)" : "(no output)")).trim();
}

export function formatToolCall(call: ToolCall): string {
  const args = call.args && typeof call.args === "object" ? (call.args as Record<string, any>) : undefined;

  if (call.name === "github_code_search") {
    const query = typeof args?.query === "string" ? args.query : "";
    const repos = Array.isArray(args?.repos) ? args.repos.length : 0;
    const owners = Array.isArray(args?.owners) ? args.owners.length : 0;
    const limit = typeof args?.limit === "number" ? args.limit : DEFAULT_MAX_SEARCH_RESULTS;
    return `github_code_search "${shorten(query.replace(/\s+/g, " ").trim(), 70)}" (limit ${limit}, repos ${repos}, owners ${owners})`;
  }

  if (call.name === "github_fetch_file") {
    const repo = typeof args?.repo === "string" ? args.repo : "?";
    const remotePath = typeof args?.path === "string" ? args.path : "?";
    const ref = typeof args?.ref === "string" && args.ref.trim() ? `@${shorten(args.ref, 16)}` : "";
    return `github_fetch_file ${repo}:${shorten(remotePath, 80)}${ref}`;
  }

  if (call.name === "read") {
    const p = typeof args?.path === "string" ? args.path : "";
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const limit = typeof args?.limit === "number" ? args.limit : undefined;
    const range = offset || limit ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
    return `read ${p}${range}`;
  }

  if (call.name === "bash") {
    const command = typeof args?.command === "string" ? args.command : "";
    const timeout = typeof args?.timeout === "number" ? args.timeout : undefined;
    const normalized = command.replace(/\s+/g, " ").trim();
    const suffix = timeout ? ` (timeout ${timeout}s)` : "";
    return `bash ${shorten(normalized, 120)}${suffix}`.trimEnd();
  }

  return call.name;
}

export function buildLibrarianSystemPrompt(maxTurns: number, workspace: string, defaultLimit: number): string {
  return [
    "You are Librarian, a GitHub code intelligence subagent.",
    "Your mission: find relevant code in public/private GitHub repos efficiently, cache only the files needed, and answer with citations.",
    "",
    "You have these tools:",
    "- github_code_search: indexed GitHub code search (fast, broad).",
    "- github_fetch_file: fetch a single repository file into local cache.",
    "- read: inspect cached files with line ranges for precise citations.",
    "- bash: optional refinement (`rg`, `fd`, `ls`) against cached files only.",
    "",
    `Workspace: ${workspace}`,
    `Default search limit: ${defaultLimit}`,
    `Turn budget: at most ${maxTurns} turns (hard cap).`,
    "",
    "Non-negotiable behavior:",
    "- Start with github_code_search before expensive operations.",
    "- For large repositories, avoid cloning. Fetch only targeted files via github_fetch_file.",
    "- Cache only files needed to prove your answer.",
    "- Never paste full files. Prefer paths + line ranges + tiny snippets.",
    "- Keep snippets short (~5-15 lines).",
    "- Only mention local cached paths that were actually returned by github_fetch_file in this run.",
    "- Evidence line ranges must come from explicit read calls over cached files.",
    "- If evidence is insufficient, say so and list the next narrow search.",
    "",
    "Workflow:",
    "1) Run github_code_search with tight query terms and optional repo/owner filters.",
    "2) Select highest-signal matches and run github_fetch_file for those paths.",
    "3) Use read (and optionally bash rg -n) on cached files to get exact line ranges.",
    "4) Do not publish Evidence line ranges unless step 3 happened for those files.",
    "5) Return concise findings with both GitHub and local cache paths.",
    "",
    "Output format (Markdown, exact section order):",
    "## Summary",
    "(1-3 sentences)",
    "## Findings",
    "- `owner/repo:path` — what it contains",
    "## Cached files",
    "- `absolute/local/path` ← `owner/repo:path@ref-or-sha`",
    "- If no files were fetched, write `(none)`",
    "## Evidence",
    "- `absolute/local/path:lineStart-lineEnd` (GitHub URL) — concise snippet/point",
    "## Searched",
    "- Queries and filters you used",
    "## Next steps (optional)",
    "- What to fetch/check if ambiguity remains",
  ].join("\n");
}

export function buildLibrarianUserPrompt(
  query: string,
  repos: string[],
  owners: string[],
  maxSearchResults: number,
): string {
  const repoLine = repos.length > 0 ? repos.join(", ") : "(none)";
  const ownerLine = owners.length > 0 ? owners.join(", ") : "(none)";

  return [
    "Task: investigate GitHub code and return evidence-first findings.",
    "",
    `Query: ${query}`,
    `Repository filters: ${repoLine}`,
    `Owner filters: ${ownerLine}`,
    `Max search results per github_code_search call: ${maxSearchResults}`,
    "",
    "Important: keep output concise, citation-heavy, and path-first.",
  ].join("\n");
}
