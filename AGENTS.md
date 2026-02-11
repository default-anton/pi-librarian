## Invariants

- Keep this package dependency-light. Do not add runtime dependencies unless strictly necessary.
- `extensions/index.ts` is the only extension entrypoint; keep orchestration there.
- Model routing policy lives in `extensions/model-selection.ts` (source of truth).
- Selection diagnostics contract lives in `extensions/librarian-core.ts` (`subagentSelection`). Keep it tight: `authMode`, `authSource`, `reason`.
- Librarian turn budget is fixed at 10 (`DEFAULT_MAX_TURNS`); do not expose `maxTurns` as a tool parameter.

## Required validation

Run after changing code (not docs-only):

```bash
npm run test:model-selection
```

## Policy changes

When changing model-selection behavior:

1. Update `extensions/model-selection.test.ts`.
2. Update README section `Model selection policy`.
3. Keep fallback behavior explicit and deterministic.

## Release process

For commit/push/tag/GitHub release/npm publish workflow, follow `docs/release-playbook.md`.
