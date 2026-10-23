'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { assert, sha256, validateManifest, failure } = require('../lib/common.cjs');
const { wrapper, registered } = require('./update-tools.cjs');

async function checkRegistry(directory) {
  const names = await registered(directory);
  for (const name of names) {
    const folder = path.join(directory, 'tools', name);
    const files = (await fs.readdir(folder)).sort();
    assert(JSON.stringify(files) === JSON.stringify(['Cargo.lock', 'action.yml', 'manifest.json']), `Unexpected files in ${name}.`);
    const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')));
    assert(manifest.name === name, 'Crate namespace does not match its manifest.');
    assert(await fs.readFile(path.join(folder, 'action.yml'), 'utf8') === wrapper(name), `Unexpected action wrapper for ${name}.`);
    assert(sha256(await fs.readFile(path.join(folder, 'Cargo.lock'))) === manifest.source.lockSha256, `Invalid Cargo.lock for ${name}.`);
  }
  return names;
}

async function main() {
  const names = await checkRegistry(path.resolve(process.env.CRATES_DIR || 'registry'));
  for (const file of await fs.readdir('.github/workflows')) {
    const content = await fs.readFile(path.join('.github/workflows', file), 'utf8');
    for (const match of content.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      assert(match[1].startsWith('./') || /@[a-f0-9]{40}$/.test(match[1]), `Unpinned action in ${file}: ${match[1]}`);
    }
  }
  assert(JSON.parse(await fs.readFile('package.json')).license === 'Apache-2.0', 'Incorrect package license.');
  console.log(`Validated ${names.length} crate namespaces and workflow action pins.`);
}

if (require.main === module) main().catch(failure);
module.exports = { checkRegistry, main };
