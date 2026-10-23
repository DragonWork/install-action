'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { assert, writeCommand, failure } = require('./common.cjs');

async function setup() {
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_ENV && process.env.GITHUB_STATE, 'Run this action in GitHub Actions.');
  const parent = await fs.realpath(process.env.RUNNER_TEMP);
  const root = await fs.mkdtemp(path.join(parent, 'dragonwork-install-'));
  await fs.chmod(root, 0o700);
  await writeCommand(process.env.GITHUB_STATE, 'install_root', root);
  await writeCommand(process.env.GITHUB_STATE, 'install_parent', parent);
  for (const [key, value] of Object.entries({
    DW_INSTALL_ROOT: root,
    DW_INSTALL_PARENT: parent,
    DW_INSTALL_NODE: process.execPath,
    DW_INSTALL_ENGINE: path.join(__dirname, 'install.cjs'),
    DW_INSTALL_PROTOCOL: '1',
  })) await writeCommand(process.env.GITHUB_ENV, key, value);
}

if (require.main === module) setup().catch(failure);
module.exports = { setup };
