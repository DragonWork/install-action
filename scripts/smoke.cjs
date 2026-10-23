'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { install } = require('../lib/install.cjs');
const { checkRegistry } = require('./check.cjs');
const { failure } = require('../lib/common.cjs');

async function main() {
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-smoke-'));
  let success = false;
  try {
    const changed = process.env.CHANGED_CRATES?.split(' ').filter(Boolean);
    for (const name of await checkRegistry(directory)) {
      if (changed && !changed.includes(name)) continue;
      const folder = path.join(directory, 'tools', name);
      const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
      if (!manifest.artifacts[`${process.platform}-${process.arch}`]) {
        console.log(`${name}: no upstream binary for this platform.`);
        continue;
      }
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
