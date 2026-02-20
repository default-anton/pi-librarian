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

- Registers a `librarian` tool for GitHub code investigation via `gh`, using known query context when provided (without guessing unknown scope).
- Runs a dedicated subagent session with a strict fixed turn budget (10 turns).
- Uses only `bash` + `read` tools in the subagent.
- Instructs the subagent to use `gh` directly for search/tree/fetch workflows.
- Caches only selected files in an isolated temporary workspace under `/tmp/pi-librarian/run-*/repos/...`.
- Returns the subagent's final Markdown answer as-is (no extension-side post-processing).
- Selects subagent model via ordered `PI_LIBRARIAN_MODELS` failover with `ctx.model` fallback.
- Emits compact selection diagnostics (`reason`) in tool details.

## Tool interface

```ts
librarian({
  query: string,
  repos?: string[],
  owners?: string[],
  maxSearchResults?: number,
})
```

## Model selection policy

Librarian uses local deterministic model routing with ordered failover.

Configure candidates with `PI_LIBRARIAN_MODELS`:

```bash
PI_LIBRARIAN_MODELS="provider/model:thinking,provider/model:thinking,..."
```

Concrete example:

```bash
export PI_LIBRARIAN_MODELS="openai-codex/gpt-5.3-codex-spark:high,google-antigravity/gemini-3-flash:medium,anthropic/claude-sonnet-4-6:high"
```

Rules:

- `thinking` must be one of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Tokens are parsed in order (comma-separated, trimmed, empty tokens ignored).
- Each token is filtered by:
  1. `ctx.modelRegistry.getAvailable()`
  2. Librarian's in-memory temporary-unavailable cache (reason-aware TTL)
- Librarian picks the first candidate passing both filters.
- If `PI_LIBRARIAN_MODELS` is unset/blank, or no candidate passes filters, Librarian tries `ctx.model` fallback using the same availability + temporary-unavailable filters.
- On any final non-abort model failure, Librarian fails over to the next available candidate.
- Temporary-unavailable TTLs are:
  - quota-like final failures: 30 minutes
  - other final failures: 10 minutes
- Librarian does not add its own retry/backoff loop for transient errors; SDK retry behavior remains the first-line retry mechanism.
- Selection diagnostics stay compact and expose only `subagentSelection.reason`.

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
