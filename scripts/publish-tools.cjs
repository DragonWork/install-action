'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assert, failure } = require('../lib/common.cjs');
const { checkRegistry } = require('./check.cjs');
const { compareVersions } = require('./update-tools.cjs');
const { api, signedCommit, tagCommit } = require('./github.cjs');

async function contents(repository, file, ref) {
  const result = await api(`/repos/${repository}/contents/${file}?ref=${encodeURIComponent(ref)}`, { optional: true });
  return result ? Buffer.from(result.content, 'base64').toString('utf8') : null;
}

async function main({ tags } = {}) {
  assert(process.env.GITHUB_REF === 'refs/heads/main', 'Publish only from main.');
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository === 'DragonWork/install-action', 'Unexpected publication repository.');
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const names = await checkRegistry(directory);
  const manifests = [];
  for (const name of names) manifests.push(JSON.parse(await fs.readFile(path.join(directory, 'tools', name, 'manifest.json'), 'utf8')));
  tags ||= new Set((await promisify(execFile)('git', ['tag', '--list'])).stdout.trim().split('\n'));
  const changed = new Set((process.env.CHANGED_CRATES || '').split(' '));
  let head = process.env.CRATES_HEAD;
  assert(/^[a-f0-9]{40}$/.test(head || ''), 'Missing expected crates branch commit.');
  const live = await api(`/repos/${repository}/git/ref/heads/crates.io`);
  assert(live.object.sha === head, 'Crates branch changed during validation; rerun the workflow.');
  const engine = await api(`/repos/${repository}/git/ref/heads/main`);
  assert(engine.object.sha === process.env.GITHUB_SHA, 'Main changed during validation; rerun the workflow.');
  for (const manifest of manifests) {
    const name = manifest.name;
    const prefix = `tools/${name}/`;
    if (tags.has(`${name}/v${manifest.version}`) && !changed.has(name)) continue;
    const changes = {};
    for (const file of ['manifest.json', 'action.yml']) {
      const relative = prefix + file;
      const candidate = await fs.readFile(path.join(directory, relative), 'utf8');
      if (candidate !== await contents(repository, relative, head)) changes[relative] = candidate;
    }
    let commit;
    if (Object.keys(changes).length) {
      const previous = await contents(repository, prefix + 'manifest.json', head);
      if (previous) {
        const old = JSON.parse(previous);
        assert(compareVersions(manifest.version, old.version) > 0, 'Refusing to replace or downgrade a published crate version.');
      }
      commit = await signedCommit(repository, 'crates.io', head,
        `${previous ? 'chore' : 'feat'}(${name}): ${previous ? 'update to' : 'add'} ${manifest.version}`, changes);
      head = commit;
    } else {
      const history = await api(`/repos/${repository}/commits?sha=crates.io&path=${prefix}manifest.json&per_page=1`);
      assert(history.length, `No publication commit for ${name}.`);
      commit = history[0].sha;
    }
    const detail = await api(`/repos/${repository}/commits/${commit}`);
    assert(detail.commit.verification.verified, `Unsigned crate commit: ${commit}`);
    assert(detail.files.every(file => file.filename.startsWith(prefix)), `Commit ${commit} contains another namespace.`);
    await tagCommit(repository, `${name}/v${manifest.version}`, commit);
    console.log(`${name}/v${manifest.version}: ${commit}`);
  }
  const metadata = {};
  for (const file of ['catalog.json', 'catalog-state.json', 'catalog-progress.json']) {
    let data;
    try { data = await fs.readFile(path.join(directory, file)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    const remote = await api(`/repos/${repository}/contents/${file}?ref=${head}`, { optional: true });
    if (hash !== remote?.sha) metadata[file] = data.toString('utf8');
  }
  if (Object.keys(metadata).length) {
    head = await signedCommit(repository, 'crates.io', head, 'chore(catalog): refresh CLI inventory', metadata);
    console.log(`Catalog: ${head}`);
  }
}

if (require.main === module) main().catch(failure);
module.exports = { contents, main };
