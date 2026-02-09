# pi-librarian

GitHub-focused research subagent package for [pi](https://github.com/badlogic/pi-mono).

## Installation

```bash
pi install git:github.com/default-anton/pi-librarian
```

Or use without installing:

```bash
pi -e git:github.com/default-anton/pi-librarian
```

## What it does

- Registers a `librarian` tool.
- Runs a dedicated subagent session with a strict turn budget.
- Uses `gh search code` via an internal `github_code_search` tool.
- Fetches only selected files into a temporary cache via `github_fetch_file`.
- Returns path-first findings with local cache paths and line-range citations.
- Selects subagent model dynamically based on current model auth mode (OAuth vs API key).
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

## Requirements

- GitHub CLI installed.
- GitHub CLI authenticated (`gh auth login`).

The tool checks auth at runtime and fails fast with an actionable message if auth is missing.

## License

Apache-2.0
