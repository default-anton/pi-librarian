import { readFile } from 'node:fs/promises';

const version = process.argv[2] ?? process.env.RELEASE_VERSION;

if (!version) {
  fail('missing version; pass <version> or set RELEASE_VERSION');
}

const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split(/\r?\n/);
const header = `## [${version}]`;
const startIndex = lines.findIndex((line) => line.startsWith(header));

if (startIndex === -1) {
  fail(`could not find ${header} section in CHANGELOG.md`);
}

let endIndex = lines.length;
for (let index = startIndex + 1; index < lines.length; index += 1) {
  if (lines[index].startsWith('## [')) {
    endIndex = index;
    break;
  }
}

const sectionLines = lines.slice(startIndex + 1, endIndex);
while (sectionLines.length > 0 && sectionLines[0].trim() === '') {
  sectionLines.shift();
}
while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === '') {
  sectionLines.pop();
}

if (sectionLines.length === 0) {
  fail(`CHANGELOG section ${header} is empty`);
}

process.stdout.write(`${sectionLines.join('\n')}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
