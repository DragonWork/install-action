'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signedCommit, release } = require('../scripts/github.cjs');
const { wrapper, compareVersions, repositoryOf } = require('../scripts/update-tools.cjs');

test('crate wrappers call the selected engine without embedding its version', () => {
  const text = wrapper('cargo_example');
  assert.match(text, /"\$DW_INSTALL_NODE" "\$DW_INSTALL_ENGINE" "\$DW_MANIFEST"/);
  assert.doesNotMatch(text, /uses:|@main|@v1/);
  assert.throws(() => wrapper('foo\nrun: bad'));
});

test('release selection compares semantic versions and constrains repository URLs', () => {
  assert(compareVersions('2.10.0', '2.9.9') > 0);
  assert(compareVersions('2.10.0', '3.0.0') < 0);
  assert.equal(repositoryOf('https://github.com/orhun/git-cliff.git'), 'orhun/git-cliff');
  assert.equal(repositoryOf('https://github.com.evil.test/orhun/git-cliff'), undefined);
});

test('publication requests a signed Conventional Commit only on the selected branch', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let request;
  global.fetch = async (url, options) => {
    request = JSON.parse(options.body);
    assert.equal(url, 'https://api.github.com/graphql');
    return Response.json({ data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40), signature: { isValid: true } } } } });
  };
  const result = await signedCommit('DragonWork/install-action', 'crates', 'a'.repeat(40),
    'chore(git-cliff): update to 2.14.2', { 'tools/git-cliff/manifest.json': '{}' });
  assert.equal(result, 'b'.repeat(40));
  assert.equal(request.variables.input.branch.refName, 'crates');
  assert.equal(request.variables.input.expectedHeadOid, 'a'.repeat(40));
  assert.equal(request.variables.input.fileChanges.additions[0].path, 'tools/git-cliff/manifest.json');
  await assert.rejects(signedCommit('DragonWork/install-action', 'other', 'a'.repeat(40), 'chore: update', {}), /branch/);
  await assert.rejects(signedCommit('DragonWork/install-action', 'crates', 'a'.repeat(40), 'Update tool', {}), /Conventional/);
});

test('publication refuses an unverified commit', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => Response.json({ data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40), signature: null } } } });
  await assert.rejects(signedCommit('DragonWork/install-action', 'crates', 'a'.repeat(40), 'chore: update', {}), /not verified/);
});

test('release recovery never moves an existing tag', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const methods = [];
  global.fetch = async (_url, options) => {
    methods.push(options.method);
    return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } });
  };
  await assert.rejects(release('DragonWork/install-action', 'git-cliff/v1.0.0', 'a'.repeat(40), 'notes'), /different commit/);
  assert.deepEqual(methods, ['GET']);
});
