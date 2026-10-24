'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { signedCommit, tagCommit, release } = require('../scripts/github.cjs');
const { wrapper, compareVersions, repositoryOf, probeReleases, publicationBudget,
  prepareShard, mergePrepared, catalogProgress, assetCandidates, assetFormat, nativeBinary,
  generate, planUpdate } = require('../scripts/update-tools.cjs');
const { main: publishTools } = require('../scripts/publish-tools.cjs');
const { publish: publishHistorical } = require('../scripts/backfill-version.cjs');
const { sample, executable, universal, tar } = require('./fixtures.cjs');
const { binaryPlatforms } = require('../scripts/binaries.cjs');

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
  assert.equal(repositoryOf('https://github.com/example/project/tree/main/crates/cli'), 'example/project');
  assert.equal(repositoryOf('https://github.com/example/project?url=other'), undefined);
});

test('publication batches leave room for API checks and priority lookups', () => {
  assert.equal(publicationBudget(99, 100), 0);
  assert.equal(publicationBudget(900, 100), 100);
  assert.equal(publicationBudget(500, 100), 50);
  assert.equal(publicationBudget(700, 100, true), 50);
});

test('multiple release variants select the ordinary package and platform archive', () => {
  const assets = names => names.map(name => ({ name, state: 'uploaded' }));
  const select = (name, names, platform = 'linux-x64') => assetCandidates(assets(names), platform, name, [name])[0].name;
  assert.equal(select('cargo-binstall', [
    'cargo-binstall-x86_64-unknown-linux-musl.full.tgz',
    'cargo-binstall-x86_64-unknown-linux-musl.tgz',
  ]), 'cargo-binstall-x86_64-unknown-linux-musl.tgz');
  assert.equal(select('zellij', [
    'zellij-no-web-x86_64-unknown-linux-musl.tar.gz',
    'zellij-x86_64-unknown-linux-musl.tar.gz',
  ]), 'zellij-x86_64-unknown-linux-musl.tar.gz');
  assert.equal(select('atuin', [
    'atuin-server-x86_64-unknown-linux-musl.tar.gz',
    'atuin-x86_64-unknown-linux-musl.tar.gz',
  ]), 'atuin-x86_64-unknown-linux-musl.tar.gz');
  assert.equal(select('eza', ['eza_x86_64-unknown-linux-musl.zip', 'eza_x86_64-unknown-linux-musl.tar.gz']),
    'eza_x86_64-unknown-linux-musl.tar.gz');
  assert.equal(select('b3sum', ['b3sum_macos_x64_bin', 'b3sum_linux_x64_bin']), 'b3sum_linux_x64_bin');
  assert.equal(assetFormat('b3sum_windows_x64_bin.exe'), 'binary');
  assert.equal(assetFormat('tool-installer.exe'), null);
  assert.equal(nativeBinary(Buffer.from('not an executable'), 'linux-x64'), false);
  assert.deepEqual(assetCandidates(assets(['tool-x86_64-linux-android.tar.gz']), 'linux-x64', 'tool', ['tool']), []);
  assert.equal(select('android-tools', ['android-tools-x86_64-unknown-linux-musl.tar.gz']),
    'android-tools-x86_64-unknown-linux-musl.tar.gz');
  assert.equal(select('tool', ['tool-linux-1.0.0.tgz']), 'tool-linux-1.0.0.tgz');
  assert.equal(select('tool', ['tool-macos-1.0.0.tgz'], 'darwin-arm64'), 'tool-macos-1.0.0.tgz');
  assert.equal(select('tool', ['tool_1.0.0_amd64.deb']), 'tool_1.0.0_amd64.deb');
  assert.equal(assetFormat('tool-x86_64-unknown-linux-musl'), 'binary');
  assert.equal(assetFormat('tool-linux'), 'binary');
  assert.equal(assetFormat('tool-linux.sha256'), null);
  for (const [extension, format] of Object.entries({ tbz2: 'tar.bz2', 'tar.bz': 'tar.bz2', txz: 'tar.xz', tzst: 'tar.zst', tzstd: 'tar.zst', tar: 'tar' })) {
    assert.equal(assetFormat(`tool-linux-x64.${extension}`), format);
  }
  assert.deepEqual(assetCandidates(assets(['tool-armv7-linux.tar.gz']), 'linux-x64', 'tool', ['tool']), []);
});

test('native headers determine supported CPUs, including both universal macOS slices', () => {
  for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']) {
    assert.deepEqual(binaryPlatforms(executable(platform)), [platform]);
  }
  for (const wide of [false, true]) assert.deepEqual(binaryPlatforms(universal(wide)), ['darwin-x64', 'darwin-arm64']);
  const truncated = universal();
  truncated.writeUInt32BE(truncated.length + 1, 16);
  assert.deepEqual(binaryPlatforms(truncated), []);
  const object = executable('linux-x64');
  object.writeUInt16LE(1, 16);
  assert.deepEqual(binaryPlatforms(object), []);
  assert.deepEqual(binaryPlatforms(Buffer.from('cafebabe00000034', 'hex')), []);
  assert.equal(nativeBinary(executable('linux-arm64'), 'linux-x64'), false);
});

test('unlabelled CPUs and optional binaries are resolved from executable contents', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const data = new Map([
    ['sample-cli-linux-1.0.0.tgz', tar({ 'sample-cli': executable('linux-x64') })],
    ['sample-cli-macos-1.0.0.tgz', tar({ 'sample-cli': universal() })],
  ]);
  let downloads = 0;
  global.fetch = async url => {
    downloads++;
    return new Response(data.get(url.split('/').at(-1)));
  };
  const release = { repository: 'example/sample-cli', tag_name: 'v1.0.0', assets: [...data].map(([name, bytes]) => ({
    name, state: 'uploaded', size: bytes.length, browser_download_url: `https://github.com/example/sample-cli/releases/download/v1.0.0/${name}`,
  })) };
  const record = { downloads: 10000, version: '1.0.0', repository: 'https://github.com/example/sample-cli', binaries: ['sample-cli', 'optional-server'] };
  const { manifest } = await generate('sample-cli', null, { record, release });
  assert.deepEqual(Object.keys(manifest.artifacts), ['linux-x64', 'darwin-x64', 'darwin-arm64']);
  assert.deepEqual(Object.keys(manifest.artifacts['linux-x64'].binaries), ['sample-cli']);
  assert.equal(downloads, 2);
  assert.equal(manifest.artifacts['darwin-x64'].sha256, manifest.artifacts['darwin-arm64'].sha256);
});

test('a misleading CPU filename cannot publish the wrong architecture', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const bytes = executable('linux-arm64');
  global.fetch = async () => new Response(bytes);
  await assert.rejects(generate('sample-cli', null, {
    record: { downloads: 10000, version: '1.0.0', repository: 'https://github.com/example/sample-cli', binaries: ['sample-cli'] },
    release: { repository: 'example/sample-cli', tag_name: 'v1.0.0', assets: [{ name: 'sample-cli-linux-x64', state: 'uploaded',
      size: bytes.length, browser_download_url: 'https://github.com/example/sample-cli/releases/download/v1.0.0/sample-cli-linux-x64' }] },
  }), /No prebuilt platform artifacts/);
});

test('bulk discovery batches release lookups and records unavailable repositories', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls++;
    assert.match(JSON.parse(options.body).query, /release\(tagName:"v1.0.0"\)/);
    return Response.json({ data: {
      r0: { nameWithOwner: 'example/tool', t0: { tagName: 'v1.0.0', isDraft: false, isPrerelease: false,
        releaseAssets: { nodes: [{ name: 'tool-x86_64-unknown-linux-musl.tar.gz', downloadUrl: 'https://github.com/example/tool/releases/download/v1.0.0/tool.tar.gz', size: 10, digest: null }] } } },
      rateLimit: { remaining: 900 },
    } });
  };
  const state = {};
  await probeReleases({ crates: {
    cli: { version: '1.0.0', repository: 'https://github.com/example/cli' },
    other: { version: '1.0.0', repository: 'https://example.com/project' },
  } }, state, {});
  assert.equal(calls, 1);
  assert.equal(state.cli.release.tag_name, 'v1.0.0');
  assert.equal(state.cli.release.repository, 'example/tool');
  assert.match(state.other.reason, /No GitHub/);
});

test('renamed repositories and canonical capitalization produce valid manifests', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const binary = executable('linux-x64');
  const url = 'https://github.com/Canonical/sample-cli/releases/download/v1.0.0/sample-cli_linux_x64_bin';
  const release = { tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [{
    name: 'sample-cli_linux_x64_bin', browser_download_url: url, size: binary.length, state: 'uploaded',
  }] };
  let lookups = 0;
  global.fetch = async (request, options) => {
    if (request === 'https://api.github.com/graphql') {
      lookups++;
      assert.match(JSON.parse(options.body).query, /owner:"old-owner"/);
      return Response.json({ data: { repository: { nameWithOwner: 'Canonical/sample-cli' } } });
    }
    if (request === 'https://api.github.com/repos/Canonical/sample-cli/releases/tags/v1.0.0') return Response.json(release);
    assert.equal(request, url);
    return new Response(binary);
  };
  const record = { version: '1.0.0', binaries: ['sample-cli'], downloads: 10000,
    repository: 'https://github.com/old-owner/sample-cli' };
  for (const cached of [undefined, release, { ...release, repository: 'Canonical/sample-cli' }]) {
    const { manifest } = await generate('sample-cli', null, { record, release: cached });
    assert.equal(manifest.repository, 'Canonical/sample-cli');
    assert.equal(manifest.artifacts['linux-x64'].url, url);
  }
  assert.equal(lookups, 2);
});

test('previous URL validation misses are automatically resolved again', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-repository-'));
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  t.after(async () => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const key of ['CRATE_NAMES', 'DISCOVER_RELEASES', 'CRATE_PROBE_SIZE', 'CRATE_BATCH_SIZE', 'GITHUB_OUTPUT']) delete process.env[key];
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ minimumDownloads: 10000, crates: {
    cli: { version: '1.0.0', downloads: 10000, binaries: ['cli'], repository: 'https://github.com/old-owner/cli' },
  } }));
  await fs.writeFile(path.join(root, 'catalog-state.json'), JSON.stringify({ cli: {
    version: '1.0.0', resolverRevision: 2, reason: 'Invalid release asset URL.', retryable: false,
    retryAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  } }));
  global.fetch = async request => {
    if (request.endsWith('/rate_limit')) return Response.json({ resources: { core: { remaining: 1000 } } });
    assert.equal(request, 'https://api.github.com/graphql');
    return Response.json({ data: { r0: { nameWithOwner: 'Canonical/cli', t0: {
      tagName: 'v1.0.0', isDraft: false, isPrerelease: false,
      releaseAssets: { nodes: [{ name: 'cli_linux_x64_bin', downloadUrl: 'https://github.com/Canonical/cli/releases/download/v1.0.0/cli_linux_x64_bin', size: 64 }] },
    } }, rateLimit: { remaining: 900 } } });
  };
  const plan = await planUpdate(root);
  assert.deepEqual(plan.names, ['cli']);
  assert.equal(plan.candidates.cli.release.repository, 'Canonical/cli');
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
  const result = await signedCommit('DragonWork/install-action', 'crates.io', 'a'.repeat(40),
    'chore(git-cliff): update to 2.14.2', { 'tools/git-cliff/manifest.json': '{}' });
  assert.equal(result, 'b'.repeat(40));
  assert.equal(request.variables.input.branch.branchName, 'crates.io');
  assert.equal(request.variables.input.expectedHeadOid, 'a'.repeat(40));
  assert.equal(request.variables.input.fileChanges.additions[0].path, 'tools/git-cliff/manifest.json');
  await assert.rejects(signedCommit('DragonWork/install-action', 'other', 'a'.repeat(40), 'chore: update', {}), /branch/);
  await assert.rejects(signedCommit('DragonWork/install-action', 'main', 'a'.repeat(40), 'chore: update', {}), /branch/);
  await assert.rejects(signedCommit('DragonWork/install-action', 'crates.io', 'a'.repeat(40), 'Update tool', {}), /Conventional/);
});

test('publication refuses an unverified commit', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => Response.json({ data: { createCommitOnBranch: { commit: { oid: 'b'.repeat(40), signature: null } } } });
  await assert.rejects(signedCommit('DragonWork/install-action', 'crates.io', 'a'.repeat(40), 'chore: update', {}), /not verified/);
});

test('tag publication never moves an existing tag', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const methods = [];
  global.fetch = async (_url, options) => {
    methods.push(options.method);
    return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } });
  };
  await assert.rejects(tagCommit('DragonWork/install-action', 'git-cliff/v1.0.0', 'a'.repeat(40)), /different commit/);
  assert.deepEqual(methods, ['GET']);
});

test('tool publication skips existing tags and recovers missing tags without GitHub Releases', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-publish-'));
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  t.after(async () => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  });
  const { manifest } = sample();
  const folder = path.join(root, 'tools', manifest.name);
  await fs.mkdir(folder, { recursive: true });
  const files = {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'action.yml': wrapper(manifest.name),
  };
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(folder, file), content);
  Object.assign(process.env, {
    CRATES_DIR: root, GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'DragonWork/install-action',
    CRATES_HEAD: 'a'.repeat(40), GITHUB_SHA: 'c'.repeat(40),
  });
  const calls = [];
  let existingTag = true;
  global.fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    assert(!url.includes('/releases'), 'Tool publication must not require GitHub Releases.');
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.github.com/repos/DragonWork/install-action/git/refs');
      assert.deepEqual(JSON.parse(options.body), { ref: 'refs/tags/sample-cli/v1.0.0', sha: 'b'.repeat(40) });
      existingTag = true;
      return Response.json({ ref: 'refs/tags/sample-cli/v1.0.0' });
    }
    assert.equal(options.method, 'GET');
    if (url.includes('/contents/')) {
      const name = new URL(url).pathname.split('/').at(-1);
      if (!(name in files)) return Response.json({}, { status: 404 });
      return Response.json({ content: Buffer.from(files[name]).toString('base64') });
    }
    if (url.includes('/heads/main')) return Response.json({ object: { sha: 'c'.repeat(40) } });
    if (url.includes('/heads/crates.io')) return Response.json({ object: { sha: 'a'.repeat(40) } });
    if (url.includes('/commits?')) return Response.json([{ sha: 'b'.repeat(40) }]);
    if (url.includes('/commits/')) return Response.json({ commit: { verification: { verified: true } },
      files: [{ filename: 'tools/sample-cli/manifest.json' }] });
    if (url.includes('/git/ref/tags/')) return existingTag
      ? Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } }) : Response.json({}, { status: 404 });
    throw new Error(`Unexpected API request: ${url}`);
  };
  await publishTools({ tags: new Set(['sample-cli/v1.0.0']) });
  await publishTools({ tags: new Set() });
  assert(calls.length > 0);
  assert(calls.every(call => call.method === 'GET'));
  calls.length = 0;
  existingTag = false;
  await publishTools({ tags: new Set() });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('preparation workers merge distinct tools and defer temporary failures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-matrix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'registry');
  const output = path.join(root, 'prepared');
  await fs.mkdir(directory);
  const names = ['alpha', 'constructor', 'broken'];
  const record = { version: '1.0.0', downloads: 10000 };
  const catalog = { minimumDownloads: 10000, crates: Object.fromEntries(names.map(name => [name, record])) };
  const plan = { names, shards: 3, candidates: Object.fromEntries(names.map(name => [name, {
    previous: null, targetVersion: '1.0.0', record,
  }])) };
  for (const [file, data] of Object.entries({ 'catalog.json': catalog, 'catalog-state.json': {}, 'update-plan.json': plan })) {
    await fs.writeFile(path.join(directory, file), JSON.stringify(data));
  }
  const generator = async name => {
    if (name === 'broken') throw new Error('fetch failed');
    const manifest = sample().manifest;
    manifest.name = name;
    return { manifest };
  };
  await Promise.all([0, 1, 2].map(shard => prepareShard(directory, output, shard, generator)));
  const progress = await mergePrepared(directory, output);
  assert.deepEqual((await fs.readdir(path.join(directory, 'tools'))).sort(), ['alpha', 'constructor']);
  assert.equal(progress.remaining, 1);
  assert.equal(progress.runnable, 0);
  assert(Date.parse(progress.nextRetryAt) > Date.now());
  const state = JSON.parse(await fs.readFile(path.join(directory, 'catalog-state.json')));
  assert.equal(state.broken.retryable, true);
  const later = catalogProgress(catalog, state, { alpha: record, constructor: record }, Date.parse(progress.nextRetryAt) + 1);
  assert.equal(later.runnable, 1);
  const bad = JSON.parse(await fs.readFile(path.join(output, 'worker-1.json')));
  bad.attempted.push('alpha');
  await fs.writeFile(path.join(output, 'worker-1.json'), JSON.stringify(bad));
  await assert.rejects(mergePrepared(directory, output), /overlap|unplanned/);
});

test('installer publication still creates a GitHub Release without moving its tag', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const writes = [];
  global.fetch = async (url, options) => {
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (url.includes('/releases/tags/')) return Response.json({}, { status: 404 });
    writes.push({ url, method: options.method });
    return Response.json({ id: 1 });
  };
  await release('DragonWork/install-action', 'v1.0.0', 'a'.repeat(40), 'notes');
  assert.equal(writes.length, 1);
  assert(writes[0].url.endsWith('/releases'));
  assert.equal(writes[0].method, 'POST');
});

test('historical versions require verified commits and never advance the catalog branch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-historical-'));
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  t.after(async () => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  });
  const { manifest } = sample();
  const folder = path.join(root, 'tools', manifest.name);
  await fs.mkdir(folder, { recursive: true });
  const files = { 'manifest.json': JSON.stringify(manifest, null, 2) + '\n', 'action.yml': wrapper(manifest.name) };
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(folder, file), content);
  await fs.writeFile(path.join(root, 'backfill.json'), JSON.stringify({ name: manifest.name, version: manifest.version, head: 'a'.repeat(40) }));
  Object.assign(process.env, { GITHUB_REPOSITORY: 'DragonWork/install-action', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'c'.repeat(40), CRATE_NAME: manifest.name, CRATE_VERSION: manifest.version });
  const writes = [];
  let verified = false, tagExists = false;
  global.fetch = async (url, options) => {
    assert(!url.includes('/releases'));
    assert(['GET', 'POST'].includes(options.method), 'Backfill must not update or delete a reference.');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      writes.push(url);
      if (url.endsWith('/git/trees')) {
        assert.equal(body.base_tree, 'd'.repeat(40));
        assert(body.tree.every(file => file.path.startsWith('tools/sample-cli/')));
        return Response.json({ sha: 'e'.repeat(40) });
      }
      if (url.endsWith('/git/commits')) {
        assert.deepEqual(body.parents, ['a'.repeat(40)]);
        assert.equal(body.message, 'chore(sample-cli): backfill 1.0.0');
        assert(!('author' in body) && !('committer' in body) && !('signature' in body));
        return Response.json({ sha: 'b'.repeat(40), verification: { verified } });
      }
      assert(url.endsWith('/git/refs'));
      assert.deepEqual(body, { ref: 'refs/tags/sample-cli/v1.0.0', sha: 'b'.repeat(40) });
      tagExists = true;
      return Response.json({});
    }
    if (url.includes('/heads/main')) return Response.json({ object: { sha: 'c'.repeat(40) } });
    if (url.includes('/heads/crates.io')) return Response.json({ object: { sha: 'a'.repeat(40) } });
    if (url.includes('/git/ref/tags/')) return tagExists
      ? Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } }) : Response.json({}, { status: 404 });
    if (url.includes('/git/commits/')) return Response.json({ tree: { sha: 'd'.repeat(40) } });
    if (url.includes('/commits/')) return Response.json({ author: { login: 'github-actions[bot]' },
      commit: { verification: { verified } }, files: [{ filename: 'tools/sample-cli/manifest.json' }] });
    if (url.includes('/contents/')) {
      const file = new URL(url).pathname.split('/').at(-1);
      return Response.json({ content: Buffer.from(files[file]).toString('base64') });
    }
    throw new Error(`Unexpected API request: ${url}`);
  };
  await assert.rejects(publishHistorical(root), /did not verify/);
  assert.equal(tagExists, false);
  verified = true;
  await publishHistorical(root);
  assert.equal(tagExists, true);
  writes.length = 0;
  await publishHistorical(root);
  assert.deepEqual(writes, []);
});
