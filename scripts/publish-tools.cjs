'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { assert, failure } = require('../lib/common.cjs');
const { checkRegistry } = require('./check.cjs');
const { compareVersions } = require('./update-tools.cjs');
const { api, signedCommit, release } = require('./github.cjs');

async function contents(repository, file, ref) {
  const result = await api(`/repos/${repository}/contents/${file}?ref=${encodeURIComponent(ref)}`, { optional: true });
  return result ? Buffer.from(result.content, 'base64').toString('utf8') : null;
}

async function main() {
  assert(process.env.GITHUB_REF === 'refs/heads/main', 'Publish only from main.');
  const repository = process.env.GITHUB_REPOSITORY;
  assert(repository === 'DragonWork/install-action', 'Unexpected publication repository.');
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const names = await checkRegistry(directory);
  let head = process.env.CRATES_HEAD;
  assert(/^[a-f0-9]{40}$/.test(head || ''), 'Missing expected crates branch commit.');
  const live = await api(`/repos/${repository}/git/ref/heads/crates`);
  assert(live.object.sha === head, 'Crates branch changed during validation; rerun the workflow.');
  const engine = await api(`/repos/${repository}/git/ref/heads/main`);
  assert(engine.object.sha === process.env.GITHUB_SHA, 'Main changed during validation; rerun the workflow.');
  for (const name of names) {
    const prefix = `tools/${name}/`;
    const manifest = JSON.parse(await fs.readFile(path.join(directory, prefix, 'manifest.json'), 'utf8'));
    const changes = {};
    for (const file of ['manifest.json', 'Cargo.lock', 'action.yml']) {
      const relative = prefix + file;
      const candidate = await fs.readFile(path.join(directory, relative), 'utf8');
      if (candidate !== await contents(repository, relative, head)) changes[relative] = candidate;
    }
    let commit;
    if (Object.keys(changes).length) {
      const previous = await contents(repository, prefix + 'manifest.json', head);
      if (previous) {
        const old = JSON.parse(previous);
        assert(compareVersions(manifest.release, old.release) > 0
          && compareVersions(manifest.version, old.version) >= 0, 'Refusing an unversioned crate update or downgrade.');
        assert(old.version !== manifest.version || old.source.sha256 === manifest.source.sha256, 'Refusing replacement of an existing crate source.');
      }
      commit = await signedCommit(repository, 'crates', head,
        `${previous ? 'chore' : 'feat'}(${name}): ${previous ? 'update to' : 'add'} ${manifest.version}`, changes);
      head = commit;
    } else {
      const history = await api(`/repos/${repository}/commits?sha=crates&path=${prefix}manifest.json&per_page=1`);
      assert(history.length, `No publication commit for ${name}.`);
      commit = history[0].sha;
    }
    const detail = await api(`/repos/${repository}/commits/${commit}`);
    assert(detail.commit.verification.verified, `Unsigned crate commit: ${commit}`);
    assert(detail.files.every(file => file.filename.startsWith(prefix)), `Commit ${commit} contains another namespace.`);
    await release(repository, `${name}/v${manifest.release}`, commit,
      `Install ${name} ${manifest.version}.\n\nPinned crate source, Cargo.lock, and available release binaries.\n\n` +
      '```yaml\n' + `- uses: DragonWork/install-action/tools/${name}@${commit} # ${name}/v${manifest.release}\n` + '```\n');
    console.log(`${name}/v${manifest.release}: ${commit}`);
  }
}

if (require.main === module) main().catch(failure);
module.exports = { contents, main };
