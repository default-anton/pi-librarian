import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createBashTool,
  createReadTool,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

import { createGithubCodeSearchTool, createGithubFetchFileTool, ensureGithubAuth } from "./github-tools";
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MAX_TURNS,
  LibrarianParams,
  MAX_TOOL_CALLS_TO_KEEP,
  asStringArray,
  buildLibrarianSystemPrompt,
  buildLibrarianUserPrompt,
  bumpDefaultEventTargetMaxListeners,
  clampNumber,
  computeOverallStatus,
  formatToolCall,
  getLastAssistantText,
  renderCombinedMarkdown,
  shorten,
  type CachedFile,
  type LibrarianDetails,
  type LibrarianRunDetails,
} from "./shared";
import { getSmallModelFromProvider } from "./model-selection";

function buildVerifiedAppendix(run: LibrarianRunDetails): string {
  const hasRead = run.toolCalls.some((call) => call.name === "read" && !call.isError);
  const files = run.cachedFiles;

  const lines: string[] = ["## Verified cache artifacts (extension)"];
  if (files.length === 0) {
    lines.push("- (none fetched)");
  } else {
    for (const file of files) {
      const source = `${file.repo}:${file.remotePath}@${file.sha ?? file.ref ?? "unknown-ref"}`;
      lines.push(`- \`${file.localPath}\` ← \`${source}\``);
    }
  }

  lines.push("", "## Verification status (extension)");
  if (hasRead) lines.push("- Evidence line ranges were validated from local cached files via `read`.");
  else lines.push("- No successful `read` call occurred; treat any line-range claims above as unverified.");

  return lines.join("\n");
}

function createTurnBudgetExtension(maxTurns: number): ExtensionFactory {
  return (pi) => {
    let turnIndex = 0;

    pi.on("turn_start", async (event) => {
      turnIndex = event.turnIndex;
    });

    pi.on("tool_call", async () => {
      if (turnIndex < maxTurns - 1) return undefined;

      const humanTurn = Math.min(turnIndex + 1, maxTurns);
      return {
        block: true,
        reason: `Tool use is disabled on the final turn (turn ${humanTurn}/${maxTurns}). Provide your final answer now without calling tools.`,
      };
    });

    pi.on("tool_result", async (event) => {
      const remainingAfter = Math.max(0, maxTurns - (turnIndex + 1));
      const humanTurn = Math.min(turnIndex + 1, maxTurns);
      const budgetLine = `[turn budget] turn ${humanTurn}/${maxTurns}; remaining after this turn: ${remainingAfter}`;

      return {
        content: [...(event.content ?? []), { type: "text", text: `\n\n${budgetLine}` }],
      };
    });
  };
}

export default function librarianExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "librarian",
    label: "Librarian",
    description:
      "GitHub research subagent: searches public/private repos via gh, caches only relevant files, and returns path-first citations with line ranges.",
    parameters: LibrarianParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      const restoreMaxListeners = bumpDefaultEventTargetMaxListeners();
      let abortListenerAdded = false;
      let onAbort: (() => void) | undefined;
      try {
        const query = typeof (params as any).query === "string" ? ((params as any).query as string).trim() : "";
        if (!query) {
          const error = "Invalid parameters: expected `query` to be a non-empty string.";
          return {
            content: [{ type: "text", text: error }],
            details: { status: "error", runs: [] } satisfies LibrarianDetails,
            isError: true,
          };
        }

        const repos = asStringArray((params as any).repos);
        const owners = asStringArray((params as any).owners);
        const maxSearchResults = clampNumber(
          (params as any).maxSearchResults,
          1,
          100,
          DEFAULT_MAX_SEARCH_RESULTS,
        );
        const maxTurns = clampNumber((params as any).maxTurns, 3, 20, DEFAULT_MAX_TURNS);

        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pi-librarian-"));
        await fs.mkdir(path.join(workspace, "repos"), { recursive: true });

        const manifestPath = path.join(workspace, "manifest.json");
        const cachedByKey = new Map<string, CachedFile>();

        const writeManifest = async () => {
          const files = [...cachedByKey.values()].sort((a, b) => a.localPath.localeCompare(b.localPath));
          await fs.writeFile(
            manifestPath,
            JSON.stringify(
              {
                workspace,
                generatedAt: new Date().toISOString(),
                files,
              },
              null,
              2,
            ),
          );
        };

        try {
          await ensureGithubAuth(pi, workspace, signal);
        } catch (error) {
          const message =
            error instanceof Error
              ? `${error.message}\n\nAuthenticate GitHub CLI first: gh auth login`
              : "GitHub CLI authentication check failed. Run: gh auth login";
          return {
            content: [{ type: "text", text: message }],
            details: { status: "error", workspace, runs: [] } satisfies LibrarianDetails,
            isError: true,
          };
        }

        const runs: LibrarianRunDetails[] = [
          {
            status: "running",
            query,
            turns: 0,
            toolCalls: [],
            cachedFiles: [],
            startedAt: Date.now(),
          },
        ];

        const modelRegistry = ctx.modelRegistry;
        const subModelSelection = getSmallModelFromProvider(modelRegistry);

        if (!subModelSelection) {
          const error = "No models available. Configure credentials (e.g. /login or auth.json) and try again.";
          runs[0].status = "error";
          runs[0].error = error;
          runs[0].summaryText = error;
          runs[0].endedAt = Date.now();
          return {
            content: [{ type: "text", text: error }],
            details: {
              status: "error",
              workspace,
              runs,
            } satisfies LibrarianDetails,
            isError: true,
          };
        }

        const subModel = subModelSelection.model;
        const subagentThinkingLevel = subModelSelection.thinkingLevel;

        let lastUpdate = 0;
        const emitAll = (force = false) => {
          const now = Date.now();
          if (!force && now - lastUpdate < 120) return;
          lastUpdate = now;

          const status = computeOverallStatus(runs);
          const text = renderCombinedMarkdown(runs);

          onUpdate?.({
            content: [{ type: "text", text }],
            details: {
              status,
              workspace,
              subagentProvider: subModel.provider,
              subagentModelId: subModel.id,
              runs,
            } satisfies LibrarianDetails,
          });
        };

        const upsertCachedFile = async (file: CachedFile) => {
          const key = `${file.repo}:${file.remotePath}:${file.sha ?? file.ref ?? ""}`;
          cachedByKey.set(key, file);
          runs[0].cachedFiles = [...cachedByKey.values()].sort((a, b) => a.localPath.localeCompare(b.localPath));
          await writeManifest();
          emitAll(true);
        };

        emitAll(true);

        const systemPrompt = buildLibrarianSystemPrompt(maxTurns, workspace, maxSearchResults);

        let toolAborted = false;
        const activeSessions = new Set<{ abort: () => Promise<void> }>();

        const markAllAborted = () => {
          for (const run of runs) {
            if (run.status !== "running") continue;
            run.status = "aborted";
            run.summaryText = run.summaryText ?? "Aborted";
            run.endedAt = Date.now();
          }
        };

        const abortAll = async () => {
          if (toolAborted) return;
          toolAborted = true;
          markAllAborted();
          emitAll(true);
          await Promise.allSettled([...activeSessions].map((session) => session.abort()));
        };

        onAbort = () => void abortAll();

        if (signal?.aborted) {
          await abortAll();
          const status = computeOverallStatus(runs);
          const text = renderCombinedMarkdown(runs);
          return {
            content: [{ type: "text", text }],
            details: {
              status,
              workspace,
              runs,
              subagentProvider: subModel.provider,
              subagentModelId: subModel.id,
            } satisfies LibrarianDetails,
            isError: status === "error",
          };
        }

        if (signal) {
          signal.addEventListener("abort", onAbort);
          abortListenerAdded = true;
        }

        const wasAborted = () => toolAborted || signal?.aborted;
        const run = runs[0];

        let session: any;
        let unsubscribe: (() => void) | undefined;

        try {
          const resourceLoader = new DefaultResourceLoader({
            noExtensions: true,
            additionalExtensionPaths: ["npm:pi-subdir-context"],
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            extensionFactories: [createTurnBudgetExtension(maxTurns)],
            systemPromptOverride: () => systemPrompt,
            skillsOverride: () => ({ skills: [], diagnostics: [] }),
          });
          await resourceLoader.reload();

          run.status = "running";
          run.turns = 0;
          run.toolCalls = [];
          run.startedAt = Date.now();
          run.endedAt = undefined;
          run.error = undefined;
          run.summaryText = undefined;

          const githubCodeSearchTool = createGithubCodeSearchTool(pi, workspace);
          const githubFetchFileTool = createGithubFetchFileTool(pi, workspace, upsertCachedFile);

          const { session: createdSession } = await createAgentSession({
            cwd: workspace,
            modelRegistry,
            resourceLoader,
            sessionManager: SessionManager.inMemory(workspace),
            model: subModel,
            thinkingLevel: subagentThinkingLevel,
            tools: [createReadTool(workspace), createBashTool(workspace)],
            customTools: [githubCodeSearchTool, githubFetchFileTool],
          });

          session = createdSession;
          activeSessions.add(session as any);

          unsubscribe = session.subscribe((event) => {
            switch (event.type) {
              case "turn_end": {
                run.turns += 1;
                emitAll();
                break;
              }
              case "tool_execution_start": {
                run.toolCalls.push({
                  id: event.toolCallId,
                  name: event.toolName,
                  args: event.args,
                  startedAt: Date.now(),
                });
                if (run.toolCalls.length > MAX_TOOL_CALLS_TO_KEEP) {
                  run.toolCalls.splice(0, run.toolCalls.length - MAX_TOOL_CALLS_TO_KEEP);
                }
                emitAll(true);
                break;
              }
              case "tool_execution_end": {
                const call = run.toolCalls.find((c) => c.id === event.toolCallId);
                if (call) {
                  call.endedAt = Date.now();
                  call.isError = event.isError;
                }
                emitAll(true);
                break;
              }
            }
          });

          await session.prompt(buildLibrarianUserPrompt(query, repos, owners, maxSearchResults), {
            expandPromptTemplates: false,
          });
          run.summaryText = getLastAssistantText(session.state.messages as any[]).trim();
          if (!run.summaryText) run.summaryText = wasAborted() ? "Aborted" : "(no output)";
          run.status = wasAborted() ? "aborted" : "done";
          run.cachedFiles = [...cachedByKey.values()].sort((a, b) => a.localPath.localeCompare(b.localPath));
          run.summaryText = `${run.summaryText.trim()}\n\n${buildVerifiedAppendix(run)}`;
          run.endedAt = Date.now();
          await writeManifest();
          emitAll(true);
        } catch (error) {
          const message = wasAborted() ? "Aborted" : error instanceof Error ? error.message : String(error);
          run.status = wasAborted() ? "aborted" : "error";
          run.error = wasAborted() ? undefined : message;
          run.summaryText = message;
          run.cachedFiles = [...cachedByKey.values()].sort((a, b) => a.localPath.localeCompare(b.localPath));
          run.endedAt = Date.now();
          emitAll(true);
        } finally {
          if (session) activeSessions.delete(session as any);
          unsubscribe?.();
          session?.dispose();
        }

        const status = computeOverallStatus(runs);
        const text = renderCombinedMarkdown(runs);

        return {
          content: [{ type: "text", text }],
          details: {
            status,
            workspace,
            runs,
            subagentProvider: subModel.provider,
            subagentModelId: subModel.id,
          } satisfies LibrarianDetails,
          isError: status === "error",
        };
      } finally {
        if (signal && abortListenerAdded && onAbort) signal.removeEventListener("abort", onAbort);
        restoreMaxListeners();
      }
    },

    renderCall(args, theme) {
      const query = typeof (args as any)?.query === "string" ? ((args as any).query as string).trim() : "";
      const repos = Array.isArray((args as any)?.repos) ? (args as any).repos.length : 0;
      const owners = Array.isArray((args as any)?.owners) ? (args as any).owners.length : 0;
      const preview = shorten(query.replace(/\s+/g, " ").trim(), 70);

      const title = theme.fg("toolTitle", theme.bold("librarian"));
      const scope = theme.fg("muted", `repos:${repos} owners:${owners}`);
      const text = title + (preview ? `\n${scope} · ${preview}` : `\n${scope}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as LibrarianDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const status = isPartial ? "running" : details.status;
      const icon =
        status === "done"
          ? theme.fg("success", "✓")
          : status === "error"
            ? theme.fg("error", "✗")
            : status === "aborted"
              ? theme.fg("warning", "◼")
              : theme.fg("warning", "⏳");

      const run = details.runs[0];
      const totalToolCalls = run?.toolCalls.length ?? 0;
      const totalTurns = run?.turns ?? 0;
      const cachedCount = run?.cachedFiles.length ?? 0;

      const header =
        icon +
        " " +
        theme.fg("toolTitle", theme.bold("librarian ")) +
        theme.fg(
          "dim",
          `${details.subagentProvider ?? "?"}/${details.subagentModelId ?? "?"} • ${totalTurns} turns • ${totalToolCalls} tool call${totalToolCalls === 1 ? "" : "s"} • ${cachedCount} cached file${cachedCount === 1 ? "" : "s"}`,
        );

      const workspaceLine = details.workspace
        ? `${theme.fg("muted", "workspace: ")}${theme.fg("toolOutput", details.workspace)}`
        : theme.fg("muted", "workspace: (none)");

      let toolsText = "";
      if (run && run.toolCalls.length > 0) {
        const calls = expanded ? run.toolCalls : run.toolCalls.slice(-6);
        const lines: string[] = [theme.fg("muted", "Tools:")];
        for (const call of calls) {
          const callIcon = call.isError ? theme.fg("error", "✗") : theme.fg("dim", "→");
          lines.push(`${callIcon} ${theme.fg("toolOutput", formatToolCall(call))}`);
        }
        if (!expanded && run.toolCalls.length > 6) lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
        toolsText = lines.join("\n");
      }

      if (status === "running") {
        let text = `${header}\n${workspaceLine}`;
        if (toolsText) text += `\n\n${toolsText}`;
        text += `\n\n${theme.fg("muted", "Searching GitHub…")}`;
        return new Text(text, 0, 0);
      }

      const mdTheme = getMarkdownTheme();
      const combined =
        (result.content[0]?.type === "text" ? result.content[0].text : renderCombinedMarkdown(details.runs)).trim() ||
        "(no output)";

      if (!expanded) {
        const previewLines = combined.split("\n").slice(0, 18).join("\n");
        let text = `${header}\n${workspaceLine}\n\n${theme.fg("toolOutput", previewLines)}`;
        if (combined.split("\n").length > 18) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        if (toolsText) text += `\n\n${toolsText}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      container.addChild(new Text(workspaceLine, 0, 0));
      if (toolsText) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(toolsText, 0, 0));
      }
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(combined, 0, 0, mdTheme));
      return container;
    },
  });
}
