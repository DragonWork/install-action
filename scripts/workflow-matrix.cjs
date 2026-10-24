'use strict';

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assert, writeCommand, failure } = require('../lib/common.cjs');

const RUNNERS = Object.freeze({
  'linux-x64': 'ubuntu-26.04', 'linux-arm64': 'ubuntu-26.04-arm',
  'darwin-x64': 'macos-15-intel', 'darwin-arm64': 'macos-15',
  'win32-x64': 'windows-2025', 'win32-arm64': 'windows-11-arm',
});

function validationMatrix(manifests) {
  const platforms = new Set(manifests.flatMap(manifest => Object.keys(manifest.artifacts)));
  for (const platform of platforms) assert(Object.hasOwn(RUNNERS, platform), 'Unknown validation platform.');
  return Object.entries(RUNNERS).filter(([platform]) => platforms.has(platform)).map(([, runner]) => runner);
}

function ciMatrix(files) {
  return !files || files.some(file => /^(lib\/|action\.yml$|package\.json$|test\/(install\.test|fixtures)\.cjs$|scripts\/workflow-matrix\.cjs$|\.github\/workflows\/ci\.yml$)/.test(file))
    ? Object.values(RUNNERS) : [RUNNERS['linux-x64']];
}

async function main() {
  const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base?.sha || event.before;
  let files;
  if (/^[a-f0-9]{40}$/.test(base || '') && !/^0+$/.test(base)) {
    try {
      const { stdout } = await promisify(execFile)('git', ['diff', '--name-only', base, 'HEAD']);
      files = stdout.trim().split('\n').filter(Boolean);
    } catch { /* A shallow checkout without the base needs the full matrix. */ }
  }
  await writeCommand(process.env.GITHUB_OUTPUT, 'runners', JSON.stringify(ciMatrix(files)));
}

if (require.main === module) main().catch(failure);
module.exports = { validationMatrix, ciMatrix };
