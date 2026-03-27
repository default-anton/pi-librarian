# Changelog

All notable changes to `pi-librarian` are documented here.

## Format

- Keep `## [Unreleased]` at the top.
- Use release headers as `## [X.Y.Z] - YYYY-MM-DD`.
- Group entries under `### Added`, `### Changed`, `### Fixed` (optionally `### Removed` / `### Security`).
- Keep entries short and operator/user-facing.

## [Unreleased]

### Added

- None.

### Changed

- None.

### Fixed

- None.

## [1.3.3] - 2026-03-27

### Added

- None.

### Changed

- Updated peer dependencies `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` to `^0.63.1` for pi 0.63.x compatibility.

### Fixed

- None.

## [1.3.2] - 2026-03-19

### Added

- None.

### Changed

- Updated the release workflow to `actions/checkout@v5` and `actions/setup-node@v5` so GitHub Actions runs on the supported Node 24 action runtime.

### Fixed

- None.

## [1.3.1] - 2026-03-19

### Added

- None.

### Changed

- None.

### Fixed

- Removed the duplicate `librarian` title from the tool call renderer so the tool name is rendered once across call/result UI.

## [1.3.0] - 2026-02-20

### Added

- None.

### Changed

- **BREAKING:** Replaced shared `pi-subagent-model-selection` routing and single-model `PI_LIBRARIAN_MODEL` override with local deterministic ordered failover via `PI_LIBRARIAN_MODELS`, including availability-filtered `ctx.model` fallback, and temporary-unavailable cache with reason-aware TTLs (quota: 30m, other final failures: 10m). Migration guidance: see `README.md` → **Model selection policy** (switch `PI_LIBRARIAN_MODEL` to ordered `PI_LIBRARIAN_MODELS="provider/model:thinking,..."`).

### Fixed

- None.

## [1.2.1] - 2026-02-18

### Added

- None.

### Changed

- None.

### Fixed

- Renamed the explicit model-override environment variable from `PI_LIBRARY_MODEL` to `PI_LIBRARIAN_MODEL` across runtime parsing, validation errors, and diagnostics reason text.
- Updated README override documentation and examples to use `PI_LIBRARIAN_MODEL`.

## [1.2.0] - 2026-02-18

### Added

- Added `PI_LIBRARY_MODEL` override (`provider/model:thinking`) for deterministic subagent model selection; when set and non-empty, Librarian bypasses `pi-subagent-model-selection`, uses the requested available model, and reports override diagnostics via explicit selection `reason`.

### Changed

- Simplified Librarian selection diagnostics payload to `reason` only and removed `authMode` / `authSource` from Librarian tool details and TUI rendering.

### Fixed

- None.

## [1.1.2] - 2026-02-17

### Added

- None.

### Changed

- Updated peer dependencies `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` to `^0.53.0`.

### Fixed

- None.

## [1.1.1] - 2026-02-13

### Added

- None.

### Changed

- Updated peer dependencies `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` to `^0.52.12`.
- Bumped internal dependency `pi-subagent-model-selection` from `^0.1.3` to `^0.1.4`.

### Fixed

- None.

## [1.1.0] - 2026-02-13

### Added

- None.

### Changed

- Tightened Librarian system/user prompts with Finder-style task framing and execution guidance: evidence-first opening, direct-response behavior, clearer default search modes, and concise evidence rules while keeping cached-file citations strict for code-content claims.

### Fixed

- None.

## [1.0.9] - 2026-02-12

### Added

- None.

### Changed

- Bumped `pi-subagent-model-selection` dependency range from `^0.1.2` to `^0.1.3`.

### Fixed

- None.

## [1.0.8] - 2026-02-12

### Added

- Added automated GitHub Actions release workflow (`.github/workflows/release.yml`) triggered by stable `vX.Y.Z` tags.
- Added release validation and notes extraction scripts: `scripts/verify-release-tag.mjs` and `scripts/changelog-release-notes.mjs`.

### Changed

- Updated release process to use trusted publishing (`npm publish --provenance --access public`) from CI instead of manual local publishing.
- Added canonical npm release scripts (`release:verify-tag`, `release:notes`, `release:gate`) to `package.json`.
- Replaced the release playbook with the automated tag-driven runbook.

### Fixed

- Synced `package-lock.json` with `package.json` dependency range so CI `npm ci` passes reliably.
