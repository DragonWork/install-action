'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { download, validateManifest, ownedDirectory, writeCommand } = require('../lib/common.cjs');
const { install } = require('../lib/install.cjs');
const { sample } = require('./fixtures.cjs');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('prebuilt installation verifies both hashes and preserves the binary name', async t => {
  const root = await temporary(t);
  const fixture = sample();
  fixture.manifest.artifacts['linux-x64'].binaries['another-name'] = fixture.manifest.artifacts['linux-x64'].binaries['sample-cli'];
  delete fixture.manifest.artifacts['linux-x64'].binaries['sample-cli'];
  const result = await install(fixture.manifest, root, { fetcher: fixture.fetcher, platform: 'linux-x64' });
  assert.deepEqual(await fs.readFile(path.join(result.bin, 'another-name')), fixture.binary);
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(await fs.readdir(path.dirname(result.bin)), ['bin']);
});

test('an archive checksum failure never installs an executable', async t => {
  const root = await temporary(t);
  const fixture = sample();
  fixture.manifest.artifacts['linux-x64'].sha256 = '0'.repeat(64);
  await assert.rejects(install(fixture.manifest, root, { fetcher: fixture.fetcher, platform: 'linux-x64' }), /Archive SHA-256/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('a binary checksum failure never installs an executable', async t => {
  const root = await temporary(t);
  const fixture = sample();
  fixture.manifest.artifacts['linux-x64'].binaries['sample-cli'].sha256 = '0'.repeat(64);
  await assert.rejects(install(fixture.manifest, root, { fetcher: fixture.fetcher, platform: 'linux-x64' }), /Executable SHA-256/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('an unavailable platform fails without downloading or building source', async t => {
  const root = await temporary(t);
  const fixture = sample();
  await assert.rejects(install(fixture.manifest, root, { platform: 'win32-arm64',
    fetcher: async () => { throw new Error('Unexpected download'); } }), /No pinned prebuilt binary/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('download rejects untrusted redirects and oversized responses', async () => {
  let calls = 0;
  await assert.rejects(download('https://github.com/example/asset', {
    fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); },
  }), /Untrusted asset host/);
  assert.equal(calls, 1);
  await assert.rejects(download('https://github.com/example/asset', {
    fetcher: async () => new Response('too large'), limit: 3,
  }), /size limit/);
});

test('manifest validation rejects paths, floating versions and missing hashes', () => {
  const fixture = sample();
  for (const mutate of [
    m => { m.version = 'latest'; },
    m => { m.name = '../escape'; },
    m => { m.artifacts['linux-x64'].sha256 = ''; },
    m => { m.artifacts['linux-x64'].binaries['sample-cli'].path = '../escape'; },
    m => { m.artifacts['linux-x64'].url = 'https://example.com/tool.tar.gz'; },
  ]) {
    const manifest = structuredClone(fixture.manifest);
    mutate(manifest);
    assert.throws(() => validateManifest(manifest));
  }
});

test('cleanup checks the exact directory and workflow commands reject newlines', async t => {
  const parent = await temporary(t);
  const child = await fs.mkdtemp(path.join(parent, 'dragonwork-install-'));
  assert.equal(await ownedDirectory(child, parent, 'dragonwork-install-'), await fs.realpath(child));
  await assert.rejects(ownedDirectory(parent, parent, 'dragonwork-install-'), /Unsafe/);
  await assert.rejects(writeCommand(path.join(parent, 'env'), 'NAME', 'value\nINJECT=true'), /Invalid/);
});
