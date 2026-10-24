'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { download, validateManifest, ownedDirectory, writeCommand, sha256, archivePath } = require('../lib/common.cjs');
const { install, main } = require('../lib/install.cjs');
const { checkYanked } = require('../lib/yank.cjs');
const { sample, tar, ar } = require('./fixtures.cjs');

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

test('standalone executables are checksum-verified and installed directly', async t => {
  const root = await temporary(t);
  const { manifest } = sample();
  const binary = Buffer.concat([Buffer.from([127, 69, 76, 70]), Buffer.alloc(60)]);
  const artifact = manifest.artifacts['linux-x64'];
  Object.assign(artifact, { format: 'binary', sha256: sha256(binary), size: binary.length });
  artifact.binaries['sample-cli'] = { path: 'sample-cli_linux_x64_bin', sha256: sha256(binary) };
  const result = await install(manifest, root, { platform: 'linux-x64', fetcher: async () => new Response(binary) });
  assert.deepEqual(await fs.readFile(path.join(result.bin, 'sample-cli')), binary);
});

test('relative archive prefixes work without permitting parent traversal', async t => {
  const root = await temporary(t);
  const { manifest, binary } = sample();
  const member = './sample-cli';
  const archive = tar({ [member]: binary });
  Object.assign(manifest.artifacts['linux-x64'], { sha256: sha256(archive), size: archive.length });
  manifest.artifacts['linux-x64'].binaries['sample-cli'].path = member;
  const result = await install(manifest, root, { platform: 'linux-x64', fetcher: async () => new Response(archive) });
  assert.deepEqual(await fs.readFile(path.join(result.bin, 'sample-cli')), binary);
  assert.equal(archivePath('./../escape'), false);
  assert.equal(archivePath('.//absolute'), false);
});

test('Debian packages install only the pinned binary without running package scripts', async t => {
  const root = await temporary(t);
  const { manifest, binary } = sample();
  const bytes = ar({
    'debian-binary': Buffer.from('2.0\n'),
    'control.tar.gz': tar({ postinst: '#!/bin/sh\nexit 99\n' }),
    'data.tar.gz': tar({ './usr/bin/sample-cli': binary }),
  });
  const artifact = manifest.artifacts['linux-x64'];
  Object.assign(artifact, { format: 'deb', sha256: sha256(bytes), size: bytes.length });
  artifact.binaries['sample-cli'].path = './usr/bin/sample-cli';
  const result = await install(manifest, root, { platform: 'linux-x64', fetcher: async () => new Response(bytes) });
  assert.deepEqual(await fs.readFile(path.join(result.bin, 'sample-cli')), binary);
  assert.deepEqual(await fs.readdir(path.dirname(result.bin)), ['bin']);
  const broken = bytes.subarray(0, bytes.length - 1);
  Object.assign(artifact, { sha256: sha256(broken), size: broken.length });
  await assert.rejects(install(manifest, root, { platform: 'linux-x64', fetcher: async () => new Response(broken) }), /Truncated Debian/);
});

test('namespaced and zero-patch upstream tags keep the exact crate version', () => {
  const { manifest } = sample();
  const artifact = manifest.artifacts['linux-x64'];
  for (const tag of ['sample-cli/v1.0.0', 'sample-cli@1.0.0', 'v1.0']) {
    artifact.releaseTag = tag;
    artifact.url = `https://github.com/example/sample-cli/releases/download/${encodeURIComponent(tag)}/sample-cli.tar.gz`;
    assert.equal(validateManifest(manifest).version, '1.0.0');
  }
  artifact.releaseTag = 'sample-cli/v2.0.0';
  assert.throws(() => validateManifest(manifest), /release tag/);
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

test('a yanked crate warns and still installs the verified pinned binary', async t => {
  const parent = await temporary(t);
  const root = await fs.mkdtemp(path.join(parent, 'dragonwork-install-'));
  const fixture = sample();
  const platform = `${process.platform}-${process.arch}`;
  fixture.manifest.artifacts = { [platform]: fixture.manifest.artifacts['linux-x64'] };
  const file = path.join(parent, 'manifest.json');
  await fs.writeFile(file, JSON.stringify(fixture.manifest));
  const originalFetch = global.fetch, originalLog = console.log, originalArgv = process.argv;
  const originalEnv = { ...process.env };
  t.after(() => {
    global.fetch = originalFetch;
    console.log = originalLog;
    process.argv = originalArgv;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  const messages = [];
  console.log = message => messages.push(message);
  global.fetch = async url => url.startsWith('https://crates.io/')
    ? Response.json({ version: { crate: 'sample-cli', num: '1.0.0', yanked: true } }) : fixture.fetcher();
  process.argv = [process.execPath, 'install.cjs', file];
  Object.assign(process.env, { DW_INSTALL_PROTOCOL: '1', DW_INSTALL_ROOT: root, DW_INSTALL_PARENT: parent,
    GITHUB_PATH: path.join(parent, 'path'), GITHUB_OUTPUT: path.join(parent, 'output') });
  await main();
  const bin = (await fs.readFile(process.env.GITHUB_PATH, 'utf8')).trim();
  assert.deepEqual(await fs.readFile(path.join(bin, 'sample-cli')), fixture.binary);
  assert(messages.some(message => message.startsWith('::warning::') && message.includes('is yanked')));
  assert.match(await fs.readFile(process.env.GITHUB_OUTPUT, 'utf8'), /version=1\.0\.0/);
});

test('registry outages and malformed yank metadata warn without blocking pinned installs', async () => {
  const { manifest } = sample();
  for (const fetcher of [
    async () => new Response('', { status: 503 }),
    async () => { throw new Error('request timed out'); },
    async () => Response.json({ version: { crate: 'different', num: '1.0.0', yanked: true } }),
  ]) {
    const messages = [];
    assert.equal(await checkYanked(manifest, { fetcher, report: message => messages.push(message) }), null);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Continuing with the checksum-pinned prebuilt binary/);
  }
  const messages = [];
  assert.equal(await checkYanked(manifest, { fetcher: async () => Response.json({ version: {
    crate: 'sample-cli', num: '1.0.0', yanked: false,
  } }), report: message => messages.push(message) }), false);
  assert.deepEqual(messages, []);
});
