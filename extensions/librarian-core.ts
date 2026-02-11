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

export interface LibrarianRunDetails {
  status: LibrarianStatus;
  query: string;
  turns: number;
  toolCalls: ToolCall[];
  summaryText?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface SubagentSelectionInfo {
  authMode: "oauth" | "api-key";
  authSource: "runtime" | "api_key" | "oauth" | "env" | "fallback" | "none";
  reason: string;
}

export interface LibrarianDetails {
  status: LibrarianStatus;
  workspace?: string;
  subagentProvider?: string;
  subagentModelId?: string;
  subagentSelection?: SubagentSelectionInfo;
  runs: LibrarianRunDetails[];
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

function getEventTargetMaxListenersState(): EventTargetMaxListenersState {
  const g = globalThis as any;
  if (!g[EVENTTARGET_MAX_LISTENERS_STATE_KEY]) g[EVENTTARGET_MAX_LISTENERS_STATE_KEY] = { depth: 0 };
  return g[EVENTTARGET_MAX_LISTENERS_STATE_KEY] as EventTargetMaxListenersState;
}

export function bumpDefaultEventTargetMaxListeners(): () => void {
  const state = getEventTargetMaxListenersState();

  const raw = process.env.PI_EVENTTARGET_MAX_LISTENERS ?? process.env.PI_ABORT_MAX_LISTENERS;
  const desired = raw !== undefined ? Number(raw) : DEFAULT_EVENTTARGET_MAX_LISTENERS;
  if (!Number.isFinite(desired) || desired < 0) return () => { };

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
    "Your mission: find relevant code in public/private GitHub repos efficiently with gh CLI, cache only the files needed, and answer with citations.",
    "",
    "You have these tools:",
    "- bash: run gh/jq/rg/fd/ls/cp/mkdir commands.",
    "- read: inspect cached files with exact line ranges for citations.",
    "",
    `Workspace: ${workspace}`,
    `Default gh search limit: ${defaultLimit}`,
    `Turn budget: at most ${maxTurns} turns (hard cap).`,
    "",
    "Non-negotiable behavior:",
    "- Use gh commands directly. Do not clone repositories unless explicitly requested.",
    "- Never write outside workspace. Cache files under `repos/<owner>/<repo>/<path>` (relative to workspace).",
    "- Cache only files needed to prove your answer.",
    "- Never paste full files. Prefer paths + line ranges + tiny snippets.",
    "- Keep snippets short (~5-15 lines).",
    "- Evidence line ranges must come from explicit read calls on cached local files.",
    "- Do not treat `gh search code` snippets (`textMatches`) as evidence by themselves.",
    "- Every evidence citation must reference a downloaded cached file path.",
    "- If evidence is insufficient, say so and list the next narrow search/fetch.",
    "",
    "Budget strategy:",
    "- Reserve the final turn for synthesis only (no tool calls on final turn).",
    "- Prefer fewer high-signal tool calls over broad trial-and-error.",
    "- Start with a small candidate batch (typically 3-6 files), then expand only if ambiguity remains.",
    "",
    "Discovery modes (choose based on query quality):",
    "- Keyword-driven: when symbols/names are known, start with `gh search code`.",
    "- Structure-driven: when names are unknown, start by mapping tree/directories, then narrow.",
    "- Mixed: combine both when partial names/context are available.",
    "",
    "Known-good gh command patterns (prefer these templates; substitute placeholders):",
    "Set variables first when needed: REPO='owner/repo'; REF='branch-or-sha'; DIR='src'; FILE='path/to/file'.",
    "0) Resolve default branch when REF is unknown:",
    "   gh repo view \"$REPO\" --json defaultBranchRef --jq '.defaultBranchRef.name'",
    `1) Code search (public or private): gh search code '<terms>' --json path,repository,sha,url,textMatches --limit ${defaultLimit}`,
    "   Optional scoping: add `--repo owner/repo` and/or `--owner owner`.",
    "2) Repo tree (fast global map): gh api \"repos/$REPO/git/trees/$REF?recursive=1\" > tree.json",
    "3) List files in a directory from tree JSON:",
    "   jq -r '.tree[] | select(.type==\"blob\" and (.path | startswith(\"src/\"))) | .path' tree.json | head",
    "4) List direct entries in a directory via contents API (good for structure-first discovery):",
    "   gh api \"repos/$REPO/contents/$DIR?ref=$REF\" --jq '.[] | [.type, .path] | @tsv'",
    "   For repo root, use: gh api \"repos/$REPO/contents?ref=$REF\" --jq '.[] | [.type, .path] | @tsv'",
    "5) Fetch a file to local cache (base64 decode):",
    "   mkdir -p \"repos/$REPO/$(dirname \"$FILE\")\"",
    "   gh api \"repos/$REPO/contents/$FILE?ref=$REF\" --jq .content | tr -d '\\n' | base64 --decode > \"repos/$REPO/$FILE\"",
    "6) Refine locally after caching: rg -n '<pattern>' \"repos/$REPO\"",
    "7) Get precise evidence ranges: use read on the cached absolute path, then cite `path:start-end`.",
    "",
    "Private repositories:",
    "- Use the same gh commands. If access is missing, gh returns 404/403; report that constraint clearly.",
    "",
    "Workflow (adaptive, not strictly linear):",
    "1) Choose discovery mode (keyword-driven, structure-driven, or mixed).",
    "2) Gather candidate files quickly with minimal calls.",
    "3) Fetch only high-signal files into `repos/...` within workspace.",
    "4) Use read on cached files to extract exact line ranges.",
    "5) Stop once evidence is sufficient; avoid over-fetching.",
    "6) Return concise findings with both GitHub and local cache paths.",
    "",
    "Output format (Markdown, exact section order):",
    "## Summary",
    "(1-3 sentences)",
    "## Locations",
    "- `absolute/local/path` or `absolute/local/path:lineStart-lineEnd` — what is here and why it matters",
    "- If no files were fetched, write `(none)`",
    "## Evidence",
    "- Snippets with paths (optionally with line ranges) citing only cached files from this run, formatted as:",
    "```path/to/file:lineStart-lineEnd",
    "code snippet here",
    "```",
    "- Evidence must only cite downloaded/cached files from this run",
    "## Searched (only if incomplete / not found)",
    "- Queries, filters, and directory/tree probes you used",
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
    `Max search results per gh search call: ${maxSearchResults}`,
    `Always pass --limit ${maxSearchResults} to gh search code unless user asks otherwise.`,
    "",
    "Important: keep output concise, citation-heavy, path-first, and cite only downloaded/cached files.",
  ].join("\n");
}
