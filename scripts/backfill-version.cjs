'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { assert, NAME, VERSION, validateManifest, writeCommand, failure } = require('../lib/common.cjs');
const { api, contents, signedCommit, tagCommit, assertMainContains } = require('./github.cjs');
const { compareVersions, cratesApi, generate, wrapper } = require('./update-tools.cjs');
const { checkRegistry } = require('./check.cjs');
const { validationMatrix } = require('./workflow-matrix.cjs');

function context() {
  assert(process.env.GITHUB_REPOSITORY === 'DragonWork/install-action'
    && process.env.GITHUB_REF === 'refs/heads/main', 'Backfill only from the main repository.');
  const name = process.env.CRATE_NAME, version = process.env.CRATE_VERSION;
  assert(NAME.test(name || '') && VERSION.test(version || ''), 'Provide an exact crate name and stable version.');
  return { name, version, base: '/repos/DragonWork/install-action' };
}

async function prepare(directory) {
  const { name, version, base } = context();
  const existing = await api(`${base}/git/ref/tags/${name}/v${version}`, { optional: true });
  let manifest, text;
  if (existing) {
    assert(existing.object.type === 'commit', 'Unexpected existing tag type.');
    const sha = existing.object.sha;
    const detail = await api(`${base}/commits/${sha}`);
    assert(detail.commit.verification.verified && detail.author?.login === 'github-actions[bot]', 'Existing crate tag must be verified and bot-authored.');
    assert(detail.files.length && detail.files.every(file => file.filename.startsWith(`tools/${name}/`)), 'Existing tag contains another namespace.');
    const repository = process.env.GITHUB_REPOSITORY;
    text = await contents(repository, `tools/${name}/manifest.json`, sha);
    manifest = validateManifest(JSON.parse(text));
    assert(manifest.name === name && manifest.version === version, 'Existing tag has the wrong crate version.');
    assert(await contents(repository, `tools/${name}/action.yml`, sha) === wrapper(name), 'Existing tag has an unexpected action wrapper.');
    const previous = await contents(repository, `tools/${name}/manifest.json`, 'crates.io');
    if (previous && compareVersions(JSON.parse(previous).version, version) >= 0) {
      console.log(`${name}/v${version} is already published and registered.`);
      await writeCommand(process.env.GITHUB_OUTPUT, 'work', 'false');
      await writeCommand(process.env.GITHUB_OUTPUT, 'platforms', '[]');
      return;
    }
  } else {
    const data = await cratesApi(`/crates/${name}`);
    const selected = data.versions.find(entry => entry.num === version && !entry.yanked);
    assert(data.crate.id === name && selected?.bin_names?.length, 'No matching non-yanked CLI crate version.');
    ({ manifest } = await generate(name, null, { manual: true, record: {
      version, binaries: selected.bin_names, downloads: data.crate.downloads,
      repository: selected.repository || data.crate.repository,
    } }));
    text = JSON.stringify(manifest, null, 2) + '\n';
  }
  const folder = path.join(directory, 'tools', name);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'manifest.json'), text);
  await fs.writeFile(path.join(folder, 'action.yml'), wrapper(name));
  await writeCommand(process.env.GITHUB_OUTPUT, 'platforms', JSON.stringify(existing ? [] : validationMatrix([manifest])));
  await writeCommand(process.env.GITHUB_OUTPUT, 'work', String(!existing));
  await writeCommand(process.env.GITHUB_OUTPUT, 'publish', 'true');
}

async function publish(directory) {
  const { name, version, base } = context();
  const manifests = await checkRegistry(directory);
  assert(manifests.length === 1 && manifests[0].name === name && manifests[0].version === version, 'Unexpected backfill manifest.');
  const prefix = `tools/${name}/`;
  const files = {};
  for (const file of ['manifest.json', 'action.yml']) files[prefix + file] = await fs.readFile(path.join(directory, prefix, file), 'utf8');
  await assertMainContains('DragonWork/install-action', process.env.GITHUB_SHA);
  const head = (await api(`${base}/git/ref/heads/crates.io`)).object.sha;
  const tag = `${name}/v${version}`;
  const existing = await api(`${base}/git/ref/tags/${tag}`, { optional: true });
  let sha;
  if (existing) {
    assert(existing.object.type === 'commit', 'Unexpected existing tag type.');
    sha = existing.object.sha;
    for (const [file, content] of Object.entries(files)) {
      const current = await api(`${base}/contents/${file}?ref=${sha}`);
      assert(Buffer.from(current.content, 'base64').toString('utf8') === content, `Refusing to replace ${tag}.`);
    }
  } else {
    const parent = await api(`${base}/git/commits/${head}`);
    const tree = await api(`${base}/git/trees`, { method: 'POST', body: {
      base_tree: parent.tree.sha,
      tree: Object.entries(files).map(([file, content]) => ({ path: file, content, type: 'blob', mode: '100644' })),
    } });
    const commit = await api(`${base}/git/commits`, { method: 'POST', body: {
      message: `chore(${name}): backfill ${version}`, tree: tree.sha, parents: [head],
    } });
    assert(commit.verification?.verified, 'GitHub did not verify the backfill commit.');
    sha = commit.sha;
  }
  const detail = await api(`${base}/commits/${sha}`);
  assert(detail.commit.verification.verified && detail.author?.login === 'github-actions[bot]', 'Backfill commit must be verified and bot-authored.');
  assert(detail.files.length && detail.files.every(file => file.filename.startsWith(prefix)), 'Backfill commit contains another namespace.');
  await tagCommit('DragonWork/install-action', tag, sha);
  const previous = await contents('DragonWork/install-action', prefix + 'manifest.json', head);
  if (!previous || compareVersions(version, JSON.parse(previous).version) > 0) {
    await signedCommit('DragonWork/install-action', 'crates.io', head, `feat(${name}): register ${version} in catalog`, files);
  }
  console.log(`${tag}: ${sha}`);
}

async function main() {
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  if (process.argv[2] === 'prepare') return prepare(directory);
  assert(process.argv[2] === 'publish', 'Expected prepare or publish.');
  return publish(directory);
}

if (require.main === module) main().catch(failure);
module.exports = { prepare, publish };
