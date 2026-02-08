import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";

import {
  DEFAULT_MAX_SEARCH_RESULTS,
  GithubCodeSearchParams,
  GithubFetchFileParams,
  type CachedFile,
  type GithubCodeSearchResult,
  asStringArray,
  clampNumber,
  shorten,
} from "./shared";

const MAX_FETCH_BYTES = 1_500_000;

function normalizeRepo(repo: string): string {
  const normalized = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`Invalid repo format: ${repo}. Expected owner/repo.`);
  }
  return normalized;
}

function normalizeRemotePath(remotePath: string): string {
  const normalized = remotePath
    .trim()
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  if (normalized.length === 0) {
    throw new Error("Invalid path: empty path is not allowed.");
  }

  if (normalized.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid path: ${remotePath}`);
  }

  return normalized.join("/");
}

function getRepoCacheDir(workspace: string, repo: string): string {
  const [owner, name] = repo.split("/");
  return path.join(workspace, "repos", owner, name);
}

function encodeRepoPath(remotePath: string): string {
  return remotePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function looksBinary(buf: Buffer): boolean {
  const sample = Math.min(buf.length, 8192);
  for (let i = 0; i < sample; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function extractSearchSnippets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const snippets: string[] = [];
  for (const match of value) {
    if (!match || typeof match !== "object") continue;
    const fragment = (match as any).fragment;
    if (typeof fragment !== "string") continue;
    const clean = fragment.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    snippets.push(shorten(clean, 220));
    if (snippets.length >= 3) break;
  }
  return snippets;
}

async function runGh(pi: ExtensionAPI, args: string[], cwd: string, signal?: AbortSignal, timeout = 120_000): Promise<string> {
  const result = await pi.exec("gh", args, { cwd, signal, timeout });
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const reason = stderr || stdout || `exit code ${result.code}`;
    throw new Error(`gh ${args.join(" ")} failed: ${shorten(reason, 400)}`);
  }
  return result.stdout;
}

export async function ensureGithubAuth(pi: ExtensionAPI, workspace: string, signal?: AbortSignal): Promise<void> {
  await runGh(pi, ["auth", "status"], workspace, signal, 30_000);
}

export function createGithubCodeSearchTool(
  pi: ExtensionAPI,
  workspace: string,
): ToolDefinition<typeof GithubCodeSearchParams, { count: number; results: GithubCodeSearchResult[] }> {
  return {
    name: "github_code_search",
    label: "GitHub Code Search",
    description: "Search GitHub code (public + private repos available to gh auth). Returns repo/path/sha/url and short snippets.",
    parameters: GithubCodeSearchParams,
    async execute(_toolCallId, params, signal) {
      const query = typeof (params as any).query === "string" ? (params as any).query.trim() : "";
      if (!query) {
        return {
          content: [{ type: "text", text: "Invalid input: query must be a non-empty string." }],
          details: { count: 0, results: [] },
        };
      }

      const repos = asStringArray((params as any).repos).map(normalizeRepo);
      const owners = asStringArray((params as any).owners);
      const limit = clampNumber((params as any).limit, 1, 100, DEFAULT_MAX_SEARCH_RESULTS);
      const matchRaw = typeof (params as any).match === "string" ? (params as any).match.trim().toLowerCase() : "";
      const match = matchRaw === "file" || matchRaw === "path" ? matchRaw : undefined;

      const args = ["search", "code", query, "--json", "path,repository,sha,url,textMatches", "--limit", String(limit)];
      for (const repo of repos) args.push("--repo", repo);
      for (const owner of owners) args.push("--owner", owner);
      if (match) args.push("--match", match);

      const stdout = await runGh(pi, args, workspace, signal, 90_000);
      let parsed: any[] = [];
      try {
        const decoded = JSON.parse(stdout);
        if (Array.isArray(decoded)) parsed = decoded;
      } catch {
        parsed = [];
      }

      const results: GithubCodeSearchResult[] = parsed
        .map((entry) => {
          const repository = entry?.repository?.nameWithOwner;
          const filePath = entry?.path;
          const sha = entry?.sha;
          const url = entry?.url;

          if (typeof repository !== "string") return null;
          if (typeof filePath !== "string") return null;
          if (typeof sha !== "string") return null;
          if (typeof url !== "string") return null;

          return {
            repository,
            path: filePath,
            sha,
            url,
            snippets: extractSearchSnippets(entry?.textMatches),
          } satisfies GithubCodeSearchResult;
        })
        .filter((entry): entry is GithubCodeSearchResult => Boolean(entry));

      const lines: string[] = [`Found ${results.length} result${results.length === 1 ? "" : "s"}.`];
      const toShow = results.slice(0, 12);
      for (let i = 0; i < toShow.length; i++) {
        const item = toShow[i];
        lines.push(`${i + 1}. ${item.repository}:${item.path}`);
        lines.push(`   sha=${item.sha}`);
        lines.push(`   url=${item.url}`);
        for (const snippet of item.snippets.slice(0, 2)) lines.push(`   snippet: ${snippet}`);
      }
      if (results.length > toShow.length) lines.push(`... ${results.length - toShow.length} more result(s).`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: results.length, results },
      };
    },
  };
}

export function createGithubFetchFileTool(
  pi: ExtensionAPI,
  workspace: string,
  onCached: (file: CachedFile) => Promise<void> | void,
): ToolDefinition<typeof GithubFetchFileParams, CachedFile> {
  return {
    name: "github_fetch_file",
    label: "GitHub Fetch File",
    description:
      "Fetch one GitHub file (optionally by blob SHA) into local cache and return an absolute local path for later read calls.",
    parameters: GithubFetchFileParams,
    async execute(_toolCallId, params, signal) {
      const repo = normalizeRepo(typeof (params as any).repo === "string" ? (params as any).repo : "");
      const remotePath = normalizeRemotePath(typeof (params as any).path === "string" ? (params as any).path : "");
      const ref = typeof (params as any).ref === "string" ? (params as any).ref.trim() : "";
      const sha = typeof (params as any).sha === "string" ? (params as any).sha.trim() : "";

      let content: Buffer | undefined;
      let resolvedSha = sha || undefined;
      let resolvedRef = ref || undefined;

      if (sha) {
        const blobEndpoint = `repos/${repo}/git/blobs/${encodeURIComponent(sha)}`;
        const blobRaw = await runGh(pi, ["api", blobEndpoint], workspace, signal, 90_000);
        const blobPayload = JSON.parse(blobRaw);
        const encoded = typeof blobPayload?.content === "string" ? blobPayload.content.replace(/\n/g, "") : "";
        if (!encoded) throw new Error(`Blob content missing for ${repo}:${remotePath}@${sha}`);
        content = Buffer.from(encoded, "base64");
        if (!resolvedSha && typeof blobPayload?.sha === "string") resolvedSha = blobPayload.sha;
      } else {
        const encodedPath = encodeRepoPath(remotePath);
        const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        const endpoint = `repos/${repo}/contents/${encodedPath}${refQuery}`;
        const fileRaw = await runGh(pi, ["api", endpoint], workspace, signal, 90_000);
        const filePayload = JSON.parse(fileRaw);

        if (filePayload?.type && filePayload.type !== "file") {
          throw new Error(`Expected a file but got type=${filePayload.type} for ${repo}:${remotePath}`);
        }

        const encoded = typeof filePayload?.content === "string" ? filePayload.content.replace(/\n/g, "") : "";
        if (!encoded) {
          throw new Error(
            `GitHub did not return inline content for ${repo}:${remotePath}. Provide blob sha from github_code_search for precise fetch.`,
          );
        }

        content = Buffer.from(encoded, "base64");
        if (typeof filePayload?.sha === "string") resolvedSha = filePayload.sha;
        if (!resolvedRef && typeof filePayload?.sha === "string") resolvedRef = filePayload.sha;
      }

      if (!content) throw new Error("No file content received.");

      if (content.byteLength > MAX_FETCH_BYTES) {
        throw new Error(
          `Refusing to cache ${repo}:${remotePath} (${content.byteLength} bytes). Limit is ${MAX_FETCH_BYTES} bytes. Narrow the target file.`,
        );
      }

      if (looksBinary(content)) {
        throw new Error(`Refusing to cache binary-looking content for ${repo}:${remotePath}.`);
      }

      const repoDir = getRepoCacheDir(workspace, repo);
      const localPath = path.join(repoDir, remotePath);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, content);

      const lines = content.byteLength === 0 ? 0 : content.toString("utf8").split(/\r?\n/).length;

      const cached: CachedFile = {
        repo,
        remotePath,
        ref: resolvedRef,
        sha: resolvedSha,
        localPath,
        bytes: content.byteLength,
        lines,
        fetchedAt: Date.now(),
      };

      await onCached(cached);

      const sourceRef = cached.sha ?? cached.ref ?? "unknown-ref";
      return {
        content: [
          {
            type: "text",
            text: [`Cached ${repo}:${remotePath}@${sourceRef}`, `Local path: ${cached.localPath}`, `Size: ${cached.bytes} bytes, ${cached.lines} lines`].join("\n"),
          },
        ],
        details: cached,
      };
    },
  };
}
