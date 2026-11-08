// Builds dist/timezone-changer-<version>.zip from the last commit.
// Uses `git archive`, so files marked export-ignore in .gitattributes
// (docs, tools, reference-docs, ...) are not in the zip.
//   npm run zip
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
fs.mkdirSync('dist', { recursive: true });
const out = `dist/timezone-changer-${version}.zip`;
execFileSync('git', ['archive', '--format=zip', `--prefix=timezone-changer-${version}/`, '-o', out, 'HEAD']);
console.log('wrote', out);
