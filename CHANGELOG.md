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
