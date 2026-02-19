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
- Selects subagent model via shared package [`pi-subagent-model-selection`](https://github.com/default-anton/pi-subagent-model-selection).
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

Default behavior delegates model selection to [`pi-subagent-model-selection`](https://github.com/default-anton/pi-subagent-model-selection) (shared with pi-finder).
The policy definition and its test suite live only in that package.

You can override the subagent model explicitly with `PI_LIBRARIAN_MODEL`:

```bash
PI_LIBRARIAN_MODEL="provider/model:thinking"
```

Concrete example:

```bash
export PI_LIBRARIAN_MODEL=google-antigravity/gemini-3-flash:low
```

- `thinking` must be one of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- When `PI_LIBRARIAN_MODEL` is set to a non-empty value, Librarian uses it instead of shared selection policy.
- The requested model must exist in `modelRegistry.getAvailable()` (i.e. credentials are configured for that provider/model).
- In override mode, selection diagnostics report an explicit `reason` including the chosen `provider/model:thinking`.

## Quota fallback

When the primary subagent model fails due to quota exhaustion or rate limits, Librarian automatically retries with a fallback model. Two failure modes are handled:

- **Exception-based**: API returns a 429 / quota error that throws — detected via error message patterns.
- **Silent failure**: Model runs but calls no tools and returns no output — detected by inspecting the completed run.

The fallback model defaults to `anthropic/claude-sonnet-4-6:high` and can be overridden:

```bash
export PI_LIBRARIAN_FALLBACK_MODEL=anthropic/claude-opus-4-6:low
```

Format is the same as `PI_LIBRARIAN_MODEL`: `provider/model:thinking`.

- Set `PI_LIBRARIAN_FALLBACK_MODEL=""` to disable fallback entirely.
- The fallback model must be available in `modelRegistry.getAvailable()`.
- If primary and fallback resolve to the same model ID, fallback is skipped.
- Selection diagnostics report `fallback (quota): provider/model:thinking` when fallback is active.

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
