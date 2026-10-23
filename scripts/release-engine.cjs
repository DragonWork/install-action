'use strict';

const fs = require('node:fs/promises');
const { assert, VERSION, failure } = require('../lib/common.cjs');
const { compareVersions } = require('./update-tools.cjs');
const { api, signedCommit, release } = require('./github.cjs');

async function main() {
  assert(process.env.GITHUB_REF === 'refs/heads/main', 'Release only from main.');
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository === 'DragonWork/install-action', 'Unexpected publication repository.');
  const version = process.env.RELEASE_VERSION;
  assert(VERSION.test(version), 'Provide a semantic version such as 1.0.1.');
  const current = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert(compareVersions(version, current.version) > 0, 'The engine version must increase.');
  const existing = await api(`/repos/${repository}/git/ref/tags/v${version}`, { optional: true });
  assert(!existing, 'This engine tag already exists.');
  const head = process.env.GITHUB_SHA;
  current.version = version;
  const commit = await signedCommit(repository, 'main', head, `chore(release): publish v${version}`, {
    'package.json': JSON.stringify(current, null, 2) + '\n',
  });
  await release(repository, `v${version}`, commit,
    `DragonWork Install ${version}.\n\nInstall tools with independent SHA pins and checksum verification.\n`, true);
  console.log(`v${version}: ${commit}`);
}

if (require.main === module) main().catch(failure);
