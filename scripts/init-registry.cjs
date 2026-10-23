'use strict';

const fs = require('node:fs/promises');
const { api } = require('./github.cjs');
const { assert, failure } = require('../lib/common.cjs');

async function main() {
  assert(process.env.GITHUB_REPOSITORY === 'DragonWork/install-action'
    && process.env.GITHUB_REF === 'refs/heads/main', 'Initialize only from the main repository.');
  const base = '/repos/DragonWork/install-action';
  if (await api(`${base}/git/ref/heads/crates.io`, { optional: true })) return;
  const files = {
    'README.md': '# DragonWork/install-action\n\n[Usage](https://github.com/DragonWork/install-action/blob/main/README.md)\n',
    '.gitattributes': '* text eol=lf\n',
    LICENSE: await fs.readFile('LICENSE', 'utf8'),
    NOTICE: await fs.readFile('NOTICE', 'utf8'),
  };
  const tree = await api(`${base}/git/trees`, { method: 'POST', body: {
    tree: Object.entries(files).map(([path, content]) => ({ path, content, type: 'blob', mode: '100644' })),
  } });
  const commit = await api(`${base}/git/commits`, { method: 'POST', body: {
    message: 'chore: initialize crates.io registry', tree: tree.sha, parents: [],
  } });
  assert(commit.verification?.verified, 'GitHub did not verify the registry initialization commit.');
  await api(`${base}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/crates.io', sha: commit.sha } });
  console.log(`Initialized crates.io: ${commit.sha}`);
}

if (require.main === module) main().catch(failure);
