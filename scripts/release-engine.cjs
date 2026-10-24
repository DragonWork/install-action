'use strict';

const fs = require('node:fs/promises');
const { assert, VERSION, failure } = require('../lib/common.cjs');
const { api, release } = require('./github.cjs');

async function main() {
  assert(process.env.GITHUB_REF === 'refs/heads/main', 'Release only from main.');
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository === 'DragonWork/install-action', 'Unexpected publication repository.');
  const current = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const version = process.env.RELEASE_VERSION || current.version;
  assert(VERSION.test(version), 'Provide a semantic installer version.');
  assert(version === current.version, 'Commit the requested version in package.json before releasing.');
  const existing = await api(`/repos/${repository}/git/ref/tags/v${version}`, { optional: true });
  if (existing) { console.log(`v${version} is already released.`); return; }
  const head = process.env.GITHUB_SHA;
  const commit = await api(`/repos/${repository}/commits/${head}`);
  assert(commit.commit.verification.verified, 'The installer commit must have a verified signature.');
  await release(repository, `v${version}`, head,
    `DragonWork/install-action ${version}.\n`, true);
  console.log(`v${version}: ${head}`);
}

if (require.main === module) main().catch(failure);
