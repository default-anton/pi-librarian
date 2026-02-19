import * as fs from "node:fs/promises";
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

import {
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MAX_TURNS,
  LibrarianParams,
  MAX_TOOL_CALLS_TO_KEEP,
  asStringArray,
  bumpDefaultEventTargetMaxListeners,
  clampNumber,
  computeOverallStatus,
  formatToolCall,
  getLastAssistantText,
  renderCombinedMarkdown,
  shorten,
  type LibrarianDetails,
  type LibrarianRunDetails,
  type SubagentSelectionInfo,
} from "./librarian-core";
import { buildLibrarianSystemPrompt, buildLibrarianUserPrompt } from "./librarian-prompts.md.ts";
import { getSmallModelFromProvider, type ThinkingLevel } from "pi-subagent-model-selection";

const VALID_OVERRIDE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type LibrarianOverrideThinkingLevel = (typeof VALID_OVERRIDE_THINKING_LEVELS)[number];
type LibrarianSubagentModel = NonNullable<ExtensionContext["model"]>;

type LibrarianSubagentModelSelection = {
  model: LibrarianSubagentModel;
  thinkingLevel: ThinkingLevel;
} & SubagentSelectionInfo;

function parseLibrarianModelOverride(rawValue: string):
  | { value: { provider: string; modelId: string; thinkingLevel: LibrarianOverrideThinkingLevel } }
  | { error: string } {
  const value = rawValue.trim();
  if (!value) return { error: "PI_LIBRARIAN_MODEL is empty." };

  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    return {
      error:
        `Invalid PI_LIBRARIAN_MODEL=\"${rawValue}\". Expected format \"provider/model:thinking\" ` +
        `where thinking is one of: ${VALID_OVERRIDE_THINKING_LEVELS.join(", ")}.`,
    };
  }

  const provider = value.slice(0, slashIndex).trim();
  const modelWithThinking = value.slice(slashIndex + 1).trim();
  const thinkingSeparator = modelWithThinking.lastIndexOf(":");

  if (thinkingSeparator <= 0 || thinkingSeparator === modelWithThinking.length - 1) {
    return {
      error:
        `Invalid PI_LIBRARIAN_MODEL=\"${rawValue}\". Expected format \"provider/model:thinking\" ` +
        `where thinking is one of: ${VALID_OVERRIDE_THINKING_LEVELS.join(", ")}.`,
    };
  }

  const modelId = modelWithThinking.slice(0, thinkingSeparator).trim();
  const thinking = modelWithThinking.slice(thinkingSeparator + 1).trim().toLowerCase();

  if (!provider || !modelId) {
    return {
      error:
        `Invalid PI_LIBRARIAN_MODEL=\"${rawValue}\". Provider/model must be non-empty and use ` +
        `\"provider/model:thinking\" format.`,
    };
  }

  if (!VALID_OVERRIDE_THINKING_LEVELS.includes(thinking as LibrarianOverrideThinkingLevel)) {
    return {
      error:
        `Invalid PI_LIBRARIAN_MODEL thinking level \"${thinking}\". Valid values: ` +
        VALID_OVERRIDE_THINKING_LEVELS.join(", "),
    };
  }

  return {
    value: {
      provider,
      modelId,
      thinkingLevel: thinking as LibrarianOverrideThinkingLevel,
    },
  };
}

function selectLibrarianSubagentModel(
  modelRegistry: ExtensionContext["modelRegistry"],
  currentModel: ExtensionContext["model"],
): { selection: LibrarianSubagentModelSelection | null; error?: string } {
  const rawOverride = process.env.PI_LIBRARIAN_MODEL?.trim() ?? "";
  if (!rawOverride) {
    return {
      selection: getSmallModelFromProvider(modelRegistry, currentModel) as LibrarianSubagentModelSelection | null,
    };
  }

  const parsed = parseLibrarianModelOverride(rawOverride);
  if ("error" in parsed) return { selection: null, error: parsed.error };

  const provider = parsed.value.provider.toLowerCase();
  const modelId = parsed.value.modelId.toLowerCase();

  const selectedModel = modelRegistry
    .getAvailable()
    .find((candidate) => candidate.provider.toLowerCase() === provider && candidate.id.toLowerCase() === modelId);

  if (!selectedModel) {
    return {
      selection: null,
      error:
        `PI_LIBRARIAN_MODEL requested \"${parsed.value.provider}/${parsed.value.modelId}\", but that model is not available. ` +
        `Check credentials (/login or auth env vars) and verify provider/model ID.`,
    };
  }

  return {
    selection: {
      model: selectedModel,
      thinkingLevel: parsed.value.thinkingLevel,
      reason: `env override: PI_LIBRARIAN_MODEL=${selectedModel.provider}/${selectedModel.id}:${parsed.value.thinkingLevel}`,
    },
  };
}

function isQuotaError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("quota") ||
    msg.includes("429") ||
    msg.includes("insufficient_quota") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("out of credits") ||
    msg.includes("billing")
  );
}

function selectLibrarianFallbackModel(
  modelRegistry: ExtensionContext["modelRegistry"],
  primaryModelId: string,
): LibrarianSubagentModelSelection | null {
  const rawFallback = (process.env.PI_LIBRARIAN_FALLBACK_MODEL ?? "anthropic/claude-sonnet-4-6:high").trim();
  if (!rawFallback) return null;

  const parsed = parseLibrarianModelOverride(rawFallback);
  if ("error" in parsed) return null;

  const provider = parsed.value.provider.toLowerCase();
  const modelId = parsed.value.modelId.toLowerCase();

  // Don't fall back to the same model we already tried
  if (modelId === primaryModelId.toLowerCase()) return null;

  const selectedModel = modelRegistry
    .getAvailable()
    .find((c) => c.provider.toLowerCase() === provider && c.id.toLowerCase() === modelId);
  if (!selectedModel) return null;

  return {
    model: selectedModel,
    thinkingLevel: parsed.value.thinkingLevel,
    reason: `fallback (quota): ${selectedModel.provider}/${selectedModel.id}:${parsed.value.thinkingLevel}`,
  };
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
      "GitHub research scout for coding and personal-assistant tasks. Use when the answer likely lives in GitHub repos, exact repo/path locations are unknown, or you'd otherwise do exploratory gh search/tree probes plus ls/rg/fd/find/grep/read on fetched files. Librarian performs targeted reconnaissance in an isolated workspace and returns concise, path-first findings with line-ranged evidence.",
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
        const maxTurns = DEFAULT_MAX_TURNS;

        const workspaceBase = "/tmp/pi-librarian";
        await fs.mkdir(workspaceBase, { recursive: true });
        const workspace = await fs.mkdtemp(path.join(workspaceBase, "run-"));
        await fs.mkdir(path.join(workspace, "repos"), { recursive: true });

        const runs: LibrarianRunDetails[] = [
          {
            status: "running",
            query,
            turns: 0,
            toolCalls: [],
            startedAt: Date.now(),
          },
        ];

        const modelRegistry = ctx.modelRegistry;
        const { selection: subModelSelection, error: selectionError } = selectLibrarianSubagentModel(
          modelRegistry,
          ctx.model,
        );

        if (!subModelSelection) {
          const error =
            selectionError ?? "No models available. Configure credentials (e.g. /login or auth.json) and try again.";
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

        let subModel = subModelSelection.model;
        let subagentThinkingLevel = subModelSelection.thinkingLevel;
        let subagentSelection: SubagentSelectionInfo = {
          reason: subModelSelection.reason,
        };
        const fallbackSelection = selectLibrarianFallbackModel(modelRegistry, subModel.id);

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
              subagentSelection,
              runs,
            } satisfies LibrarianDetails,
          });
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
              subagentSelection,
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

        const looksLikeSilentQuotaFailure = (r: typeof run) =>
          r.status === "done" && r.toolCalls.length === 0 && (!r.summaryText || r.summaryText === "(no output)");

        const runOneAttempt = async (attemptModel: LibrarianSubagentModel, attemptThinking: ThinkingLevel) => {
          // Clean up any previous attempt's session before starting a new one
          if (session) {
            activeSessions.delete(session as any);
            unsubscribe?.();
            session.dispose();
            session = undefined;
            unsubscribe = undefined;
          }

          run.status = "running";
          run.turns = 0;
          run.toolCalls = [];
          run.startedAt = Date.now();
          run.endedAt = undefined;
          run.error = undefined;
          run.summaryText = undefined;

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

          const { session: createdSession } = await createAgentSession({
            cwd: workspace,
            modelRegistry,
            resourceLoader,
            sessionManager: SessionManager.inMemory(workspace),
            model: attemptModel,
            thinkingLevel: attemptThinking,
            tools: [createReadTool(workspace), createBashTool(workspace)],
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
          run.endedAt = Date.now();
          emitAll(true);
        };

        try {
          try {
            await runOneAttempt(subModel, subagentThinkingLevel);
            // Detect silent quota exhaustion: model ran, made no tool calls, returned nothing
            if (!wasAborted() && fallbackSelection && looksLikeSilentQuotaFailure(run)) {
              subModel = fallbackSelection.model;
              subagentThinkingLevel = fallbackSelection.thinkingLevel;
              subagentSelection = { reason: `${fallbackSelection.reason} (silent quota)` };
              emitAll(true);
              await runOneAttempt(subModel, subagentThinkingLevel);
            }
          } catch (primaryError) {
            if (!wasAborted() && fallbackSelection && isQuotaError(primaryError)) {
              // Switch to fallback model and retry
              subModel = fallbackSelection.model;
              subagentThinkingLevel = fallbackSelection.thinkingLevel;
              subagentSelection = { reason: fallbackSelection.reason };
              emitAll(true);
              await runOneAttempt(subModel, subagentThinkingLevel);
            } else {
              throw primaryError;
            }
          }
        } catch (error) {
          const message = wasAborted() ? "Aborted" : error instanceof Error ? error.message : String(error);
          run.status = wasAborted() ? "aborted" : "error";
          run.error = wasAborted() ? undefined : message;
          run.summaryText = message;
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
            subagentSelection,
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

      const header =
        icon +
        " " +
        theme.fg("toolTitle", theme.bold("librarian ")) +
        theme.fg(
          "dim",
          `${details.subagentProvider ?? "?"}/${details.subagentModelId ?? "?"} • ${totalTurns} turns • ${totalToolCalls} tool call${totalToolCalls === 1 ? "" : "s"}`,
        );

      const workspaceLine = details.workspace
        ? `${theme.fg("muted", "workspace: ")}${theme.fg("toolOutput", details.workspace)}`
        : theme.fg("muted", "workspace: (none)");

      const selectionReasonLine = details.subagentSelection
        ? `${theme.fg("muted", "selection: ")}${theme.fg("toolOutput", details.subagentSelection.reason)}`
        : undefined;

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
        if (expanded && selectionReasonLine) text += `\n${selectionReasonLine}`;
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
      if (selectionReasonLine) container.addChild(new Text(selectionReasonLine, 0, 0));
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
