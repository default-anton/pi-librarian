# pi-librarian

GitHub-focused research subagent package for [pi](https://github.com/badlogic/pi-mono).

## Installation

From npm (after publish):

```bash
pi install npm:pi-librarian
```

From git:

```bash
pi install git:github.com/default-anton/pi-librarian
```

Or use without installing:

```bash
pi -e npm:pi-librarian
# or
pi -e git:github.com/default-anton/pi-librarian
```

## What it does

- Registers a `librarian` tool.
- Runs a dedicated subagent session with a strict turn budget.
- Uses only `bash` + `read` tools in the subagent.
- Instructs the subagent to use `gh` directly for search/tree/fetch workflows.
- Caches only selected files in an isolated temporary workspace under `/tmp/pi-librarian/run-*/repos/...`.
- Returns the subagent's final Markdown answer as-is (no extension-side post-processing).
- Selects subagent model dynamically based on current model auth mode (OAuth vs API key) via shared package `pi-subagent-model-selection`.
- Emits compact selection diagnostics (`authMode`, `authSource`, `reason`) in tool details.

## Tool interface

```ts
librarian({
  query: string,
  repos?: string[],
  owners?: string[],
  maxSearchResults?: number,
  maxTurns?: number,
})
```

## Model selection policy

Librarian picks the subagent model from `ctx.modelRegistry.getAvailable()` using this order:

- If current model uses OAuth credentials:
  1. `google-antigravity/gemini-3-flash`
  2. Fallback strategy
- If current model uses API key credentials:
  1. `google-vertex` Gemini 3 Flash (accepts `gemini-3-flash*` IDs)
  2. `google` Gemini 3 Flash (accepts `gemini-3-flash*` IDs)
  3. Fallback strategy

Fallback strategy:
1. Gemini 3 Flash on current provider
2. Claude Haiku 4.5 on current provider
3. Current model with `thinkingLevel: low`

If there is no current model in context, Librarian defaults to API-key policy and records this in selection diagnostics.

## gh workflow examples (tested)

These are the same patterns encoded in the librarian system prompt.

### Public repo example (`cli/cli`)

```bash
# code search
gh search code "NewCmdRoot" --repo cli/cli --json path,repository,sha,url,textMatches --limit 3

# repo tree
gh api "repos/cli/cli/git/trees/trunk?recursive=1"

# fetch one file into local cache
REPO='cli/cli'
REF='trunk'
FILE='pkg/cmd/root/root.go'
mkdir -p "repos/$REPO/$(dirname "$FILE")"
gh api "repos/$REPO/contents/$FILE?ref=$REF" --jq .content | tr -d '\n' | base64 --decode > "repos/$REPO/$FILE"
```

### Private repo example (`default-anton/jagc`)

```bash
# code search with path matching
gh search code "README.md" --repo default-anton/jagc --match path --json path,repository,sha,url --limit 3

# repo tree
gh api "repos/default-anton/jagc/git/trees/main?recursive=1"

# fetch one file into local cache
REPO='default-anton/jagc'
REF='main'
FILE='README.md'
mkdir -p "repos/$REPO/$(dirname "$FILE")"
gh api "repos/$REPO/contents/$FILE?ref=$REF" --jq .content | tr -d '\n' | base64 --decode > "repos/$REPO/$FILE"
```

If a repo is inaccessible, `gh` returns 404/403; the subagent should report that constraint.

## Requirements

- GitHub CLI installed.
- GitHub CLI authenticated (`gh auth login`).

No proactive auth pre-check is performed; command failures from `gh` are surfaced directly.

The subagent runs with `cwd` set to that temporary workspace, so relative writes stay in `/tmp/pi-librarian/run-*` and do not touch your project repository.

## License

Apache-2.0
