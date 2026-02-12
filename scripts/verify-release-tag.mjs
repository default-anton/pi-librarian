import { readFile } from 'node:fs/promises';

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];

if (!tag) {
  fail('missing release tag; pass <tag> or set GITHUB_REF_NAME');
}

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  fail(`invalid tag '${tag}'; expected v<major>.<minor>.<patch> (stable releases only)`);
}

const expectedVersion = tag.slice(1);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

if (pkg.version !== expectedVersion) {
  fail(`package.json version ${pkg.version} does not match tag ${tag}`);
}

const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const unreleasedHeader = /^## \[Unreleased\]$/m;
if (!unreleasedHeader.test(changelog)) {
  fail('CHANGELOG.md must contain a "## [Unreleased]" section');
}

const versionHeaderRegex = new RegExp(`^## \\[${escapeRegExp(expectedVersion)}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
if (!versionHeaderRegex.test(changelog)) {
  fail(`CHANGELOG.md must contain a release section header: ## [${expectedVersion}] - YYYY-MM-DD`);
}

const unreleasedIndex = changelog.search(unreleasedHeader);
const versionIndex = changelog.search(versionHeaderRegex);
if (versionIndex < unreleasedIndex) {
  fail('CHANGELOG.md version section must appear after [Unreleased]');
}

process.stdout.write(`release metadata ok for ${tag}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
