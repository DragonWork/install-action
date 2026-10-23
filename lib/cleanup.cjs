'use strict';

const fs = require('node:fs/promises');
const { ownedDirectory, failure } = require('./common.cjs');

async function cleanup() {
  const root = process.env.STATE_install_root;
  if (!root) return;
  const directory = await ownedDirectory(root, process.env.STATE_install_parent, 'dragonwork-install-');
  await fs.rm(directory, { recursive: true });
}

if (require.main === module) cleanup().catch(failure);
module.exports = { cleanup };
