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

## Requirements

- GitHub CLI installed.
- GitHub CLI authenticated (`gh auth login`).

The tool checks auth at runtime and fails fast with an actionable message if auth is missing.

## License

Apache-2.0
