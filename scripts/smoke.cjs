'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { install } = require('../lib/install.cjs');
const { checkRegistry } = require('./check.cjs');
const { assert, failure } = require('../lib/common.cjs');

async function main() {
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-smoke-'));
  let success = false;
  try {
    const changed = (process.env.CHANGED_CRATES || process.env.CRATE_NAME)?.split(' ').filter(Boolean);
    const manifests = await checkRegistry(directory);
    assert(manifests.length && (!changed || changed.every(name => manifests.some(manifest => manifest.name === name))),
      'Missing tool manifests for validation.');
    for (const manifest of manifests) {
      const { name } = manifest;
      if (changed && !changed.includes(name)) continue;
      if (!manifest.artifacts[`${process.platform}-${process.arch}`]) {
        console.log(`${name}: no upstream binary for this platform.`);
        continue;
      }
      console.log(`${name} ${manifest.version}: installing for ${process.platform}-${process.arch}.`);
      const result = await install(manifest, root);
      console.log(`${name} ${result.version}: ${result.bin}`);
    }
    success = true;
  } finally {
    if (success) await fs.rm(root, { recursive: true });
    else console.error(`Retained failed installation files: ${root}`);
  }
}

if (require.main === module) main().catch(failure);
