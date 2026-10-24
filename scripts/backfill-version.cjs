'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { assert, NAME, VERSION, writeCommand, failure } = require('../lib/common.cjs');
const { api, tagCommit, assertMainContains } = require('./github.cjs');
const { generate, wrapper } = require('./update-tools.cjs');
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
  const response = await fetch(`https://crates.io/api/v1/crates/${name}`, {
    redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'DragonWork/install-action (https://github.com/DragonWork/install-action)' },
  });
  assert(response.ok, `crates.io ${name}: HTTP ${response.status}`);
  const data = await response.json();
  const selected = data.versions.find(entry => entry.num === version && !entry.yanked);
  assert(data.crate.id === name && selected?.bin_names?.length, 'No matching non-yanked CLI crate version.');
  const { manifest } = await generate(name, null, { record: {
    version, binaries: selected.bin_names, downloads: data.crate.downloads,
    repository: selected.repository || data.crate.repository,
  } });
  const head = (await api(`${base}/git/ref/heads/crates.io`)).object.sha;
  const folder = path.join(directory, 'tools', name);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(folder, 'action.yml'), wrapper(name));
  await fs.writeFile(path.join(directory, 'backfill.json'), JSON.stringify({ name, version, head }) + '\n');
  await writeCommand(process.env.GITHUB_OUTPUT, 'platforms', JSON.stringify(validationMatrix([manifest])));
}

async function publish(directory) {
  const { name, version, base } = context();
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'backfill.json'), 'utf8'));
  assert(metadata.name === name && metadata.version === version && /^[a-f0-9]{40}$/.test(metadata.head), 'Unexpected backfill artifact.');
  assert(JSON.stringify(await checkRegistry(directory)) === JSON.stringify([name]), 'Unexpected backfill namespace.');
  const prefix = `tools/${name}/`;
  const files = {};
  for (const file of ['manifest.json', 'action.yml']) files[prefix + file] = await fs.readFile(path.join(directory, prefix, file), 'utf8');
  assert(JSON.parse(files[prefix + 'manifest.json']).version === version, 'Unexpected backfill version.');
  await assertMainContains('DragonWork/install-action', process.env.GITHUB_SHA);
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
    const current = await api(`${base}/git/ref/heads/crates.io`);
    assert(current.object.sha === metadata.head, 'Catalog changed during validation; rerun the workflow.');
    const parent = await api(`${base}/git/commits/${metadata.head}`);
    const tree = await api(`${base}/git/trees`, { method: 'POST', body: {
      base_tree: parent.tree.sha,
      tree: Object.entries(files).map(([file, content]) => ({ path: file, content, type: 'blob', mode: '100644' })),
    } });
    const commit = await api(`${base}/git/commits`, { method: 'POST', body: {
      message: `chore(${name}): backfill ${version}`, tree: tree.sha, parents: [metadata.head],
    } });
    assert(commit.verification?.verified, 'GitHub did not verify the backfill commit.');
    sha = commit.sha;
  }
  const detail = await api(`${base}/commits/${sha}`);
  assert(detail.commit.verification.verified && detail.author?.login === 'github-actions[bot]', 'Backfill commit must be verified and bot-authored.');
  assert(detail.files.length && detail.files.every(file => file.filename.startsWith(prefix)), 'Backfill commit contains another namespace.');
  await tagCommit('DragonWork/install-action', tag, sha);
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
