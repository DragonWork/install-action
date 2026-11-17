'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assert, failure } = require('../lib/common.cjs');
const { checkRegistry } = require('./check.cjs');
const { compareVersions } = require('./update-tools.cjs');
const { api, contents, signedCommit, tagCommit, tagRefs, assertMainContains } = require('./github.cjs');

async function main({ tags } = {}) {
  assert(process.env.GITHUB_REF === 'refs/heads/main', 'Publish only from main.');
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository === 'DragonWork/install-action', 'Unexpected publication repository.');
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const manifests = await checkRegistry(directory);
  tags ||= await tagRefs();
  const changed = new Set((process.env.CHANGED_CRATES || '').split(' '));
  const base = process.env.CRATES_HEAD;
  assert(/^[a-f0-9]{40}$/.test(base || ''), 'Missing expected crates branch commit.');
  let head = (await api(`/repos/${repository}/git/ref/heads/crates.io`)).object.sha;
  await assertMainContains(repository, process.env.GITHUB_SHA);
  const metadata = {};
  for (const file of ['catalog.json', 'catalog-state.json', 'catalog-progress.json']) {
    let data;
    try { data = await fs.readFile(path.join(directory, file)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    const endpoint = `/repos/${repository}/contents/${file}?ref=`;
    const remote = await api(endpoint + head, { optional: true });
    if (hash === remote?.sha) continue;
    if (head !== base) {
      const original = await api(endpoint + base, { optional: true });
      assert(original?.sha === remote?.sha, `${file} changed in another update; start a new Update crates run.`);
    }
    metadata[file] = data.toString('utf8');
  }
  for (const manifest of manifests) {
    const name = manifest.name;
    const prefix = `tools/${name}/`;
    const tag = `${name}/v${manifest.version}`;
    let tagged;
    if (tags.has(tag)) {
      if (!changed.has(name)) continue;
      tagged = await api(`/repos/${repository}/commits/${encodeURIComponent(tag)}`);
      assert(tagged.commit.verification.verified && tagged.files.length && tagged.files.every(file => file.filename.startsWith(prefix)),
        `Unexpected publication commit for ${tag}.`);
    }
    const changes = {};
    let previous;
    for (const file of ['manifest.json', 'action.yml']) {
      const relative = prefix + file;
      const candidate = await fs.readFile(path.join(directory, relative), 'utf8');
      if (tagged) assert(await contents(repository, relative, tagged.sha) === candidate, `Refusing to replace ${tag}.`);
      const published = await contents(repository, relative, head);
      if (file === 'manifest.json' && published) previous = JSON.parse(published);
      if (candidate !== published) changes[relative] = candidate;
    }
    let commit;
    if (Object.keys(changes).length) {
      if (previous) {
        assert(compareVersions(manifest.version, previous.version) > 0, 'Refusing to replace or downgrade a published crate version.');
      }
      commit = await signedCommit(repository, 'crates.io', head,
        `${previous ? 'chore' : 'feat'}(${name}): ${previous ? 'update to' : 'add'} ${manifest.version}`, changes);
      head = commit;
    }
    if (tagged) continue;
    if (!commit) {
      const history = await api(`/repos/${repository}/commits?sha=crates.io&path=${prefix}manifest.json&per_page=1`);
      assert(history.length, `No publication commit for ${name}.`);
      commit = history[0].sha;
    }
    const detail = await api(`/repos/${repository}/commits/${commit}`);
    assert(detail.commit.verification.verified, `Unsigned crate commit: ${commit}`);
    assert(detail.files.length && detail.files.every(file => file.filename.startsWith(prefix)), `Unexpected publication commit for ${tag}.`);
    await tagCommit(repository, tag, commit);
    console.log(`${tag}: ${commit}`);
  }
  if (Object.keys(metadata).length) {
    head = await signedCommit(repository, 'crates.io', head, 'chore(catalog): refresh CLI inventory', metadata);
    console.log(`Catalog: ${head}`);
  }
}

if (require.main === module) main().catch(failure);
module.exports = { contents, main };
