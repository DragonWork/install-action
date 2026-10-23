'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { assert, NAME, VERSION, sha256, download, extractBinary, archivePath, validateManifest,
  writeCommand, failure } = require('../lib/common.cjs');
const { api } = require('./github.cjs');

const TARGETS = {
  'linux-x64': ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'],
  'linux-arm64': ['aarch64-unknown-linux-musl', 'aarch64-unknown-linux-gnu'],
  'darwin-x64': ['x86_64-apple-darwin'],
  'darwin-arm64': ['aarch64-apple-darwin'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu'],
  'win32-arm64': ['aarch64-pc-windows-msvc'],
};
const ARCHIVE = /\.(tar\.(gz|xz|zst)|tgz|zip)$/;

async function probeReleases(catalog, state, current, limit = 2000) {
  const now = Date.now();
  const due = Object.keys(catalog.crates).filter(name => {
    const version = catalog.crates[name].version;
    if (current[name] && compareVersions(current[name].version, version) >= 0) return false;
    return state[name]?.version !== version || Date.parse(state[name].retryAfter || 0) <= now;
  });
  due.sort((a, b) => Number(Boolean(current[b])) - Number(Boolean(current[a]))
    || Number(Boolean(state[a])) - Number(Boolean(state[b])) || a.localeCompare(b));
  const requests = [];
  const retryAfter = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  for (const name of due) {
    const entry = catalog.crates[name];
    const repository = repositoryOf(entry.repository);
    if (!repository) {
      state[name] = { version: entry.version, reason: 'No GitHub release repository.', retryAfter };
      continue;
    }
    if (requests.length < limit) requests.push({ name, entry, repository });
  }
  for (let offset = 0; offset < requests.length; offset += 50) {
    const block = requests.slice(offset, offset + 50);
    const fields = block.map(({ name, entry, repository }, index) => {
      const [owner, repo] = repository.split('/');
      const tags = [`v${entry.version}`, `${name}-v${entry.version}`, `${name}-${entry.version}`, entry.version];
      return `r${index}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) {` +
        tags.map((tag, j) => `t${j}: release(tagName:${JSON.stringify(tag)}) {
          tagName isDraft isPrerelease releaseAssets(first:100) { nodes { name downloadUrl size digest } }
        }`).join('\n') + '}';
    });
    let response;
    try {
      response = await api('/graphql', { method: 'POST', body: {
        query: `{ ${fields.join('\n')} rateLimit { remaining resetAt } }`,
      } });
    } catch (error) {
      if (!/HTTP (403|429)/.test(error.message)) throw error;
      console.log(`Discovery deferred; completed batches will be retained. ${error.message}`);
      break;
    }
    assert(response.data, `Release discovery failed: ${response.errors?.[0]?.message || 'empty response'}`);
    for (let index = 0; index < block.length; index++) {
      const { name, entry } = block[index];
      const releases = Object.values(response.data[`r${index}`] || {}).filter(Boolean);
      const found = releases.find(r => !r.isDraft && !r.isPrerelease
        && r.releaseAssets.nodes.some(a => ARCHIVE.test(a.name)));
      state[name] = { version: entry.version, retryAfter, ...(found ? { release: {
        tag_name: found.tagName, assets: found.releaseAssets.nodes.filter(a => ARCHIVE.test(a.name)).map(a => ({ name: a.name,
          browser_download_url: a.downloadUrl, size: a.size, digest: a.digest, state: 'uploaded' })),
      } } : { reason: 'No matching upstream binary release.' }) };
    }
    console.log(`Checked binary releases for ${Math.min(offset + block.length, requests.length)} / ${requests.length} crates.`);
    if (response.data.rateLimit?.remaining < 150) break;
    if (offset + 50 < requests.length) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

function wrapper(name) {
  assert(NAME.test(name), 'Invalid crate name.');
  return `name: DragonWork/install-action (${name})
description: Install a checksum-pinned ${name} release.
author: DragonWork
outputs:
  version:
    description: Installed crate version.
    value: \${{ steps.install.outputs.version }}
  path:
    description: Directory containing installed binaries.
    value: \${{ steps.install.outputs.path }}
runs:
  using: composite
  steps:
    - id: install
      shell: bash
      env:
        DW_MANIFEST: \${{ github.action_path }}/manifest.json
      run: |
        : "\${DW_INSTALL_NODE:?Run DragonWork/install-action first}"
        : "\${DW_INSTALL_ENGINE:?Run DragonWork/install-action first}"
        "$DW_INSTALL_NODE" "$DW_INSTALL_ENGINE" "$DW_MANIFEST"
`;
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function publicationBudget(remaining, requested, priority = false) {
  return Math.max(0, Math.min(requested, Math.floor((remaining - 100) / (priority ? 12 : 8))));
}

async function cratesApi(endpoint) {
  const response = await fetch(`https://crates.io/api/v1${endpoint}`, {
    redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'DragonWork/install-action (https://github.com/DragonWork/install-action)' },
  });
  assert(response.ok, `crates.io ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

function repositoryOf(value) {
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(value || '');
  return match?.[1];
}

async function prebuilts(name, version, repository, binaries, temporary, knownRelease) {
  if (!repository) return {};
  let release = knownRelease;
  for (const tag of knownRelease ? [] : [`v${version}`, `${name}-v${version}`, `${name}-${version}`, version]) {
    release = await api(`/repos/${repository}/releases/tags/${tag}`, { optional: true });
    if (release && !release.draft && !release.prerelease) break;
    release = undefined;
  }
  if (!release) return {};
  const artifacts = {};
  for (const [platform, targets] of Object.entries(TARGETS)) {
    let asset;
    for (const target of targets) {
      const candidates = release.assets.filter(a => a.name.includes(target)
        && ARCHIVE.test(a.name) && a.state === 'uploaded');
      if (candidates.length === 1) { asset = candidates[0]; break; }
    }
    if (!asset) continue;
    const format = asset.name.endsWith('.zip') ? 'zip' : asset.name.endsWith('.tar.xz') ? 'tar.xz'
      : asset.name.endsWith('.tar.zst') ? 'tar.zst' : 'tar.gz';
    const archive = path.join(temporary, `${platform}.${format}`);
    const expected = /^sha256:[a-f0-9]{64}$/.test(asset.digest || '') ? asset.digest.slice(7) : undefined;
    const bytes = await download(asset.browser_download_url, { expected, size: asset.size });
    await fs.writeFile(archive, bytes, { flag: 'wx' });
    const { stdout } = await execute(format === 'zip' ? 'unzip' : 'tar',
      format === 'zip' ? ['-Z1', archive] : ['-tf', archive], { maxBuffer: 8 * 1024 * 1024 });
    const paths = stdout.trim().split(/\r?\n/);
    const found = {};
    for (const binary of binaries) {
      const filename = binary + (platform.startsWith('win32-') ? '.exe' : '');
      const matches = paths.filter(member => archivePath(member) && path.posix.basename(member) === filename);
      if (matches.length !== 1) break;
      found[filename] = { path: matches[0], sha256: sha256(await extractBinary(archive, { format, executable: matches[0] })) };
    }
    if (Object.keys(found).length === binaries.length) artifacts[platform] = {
      url: asset.browser_download_url, releaseTag: release.tag_name,
      sha256: sha256(bytes), size: bytes.length, format, binaries: found,
    };
    await fs.unlink(archive);
  }
  return artifacts;
}

async function generate(name, previous, { record, release: knownRelease } = {}) {
  assert(NAME.test(name), 'Invalid crate name.');
  if (record) assert(record.downloads >= 10000, `${name} has fewer than 10,000 total downloads.`);
  let selected = record && { num: record.version, bin_names: record.binaries, repository: record.repository };
  if (!selected) {
    const data = await cratesApi(`/crates/${name}`);
    assert(data.crate.id === name, `Use the canonical crate name: ${data.crate.id}`);
    assert(data.crate.downloads >= 10000, `${name} has fewer than 10,000 total downloads.`);
    selected = data.versions.filter(v => !v.yanked && VERSION.test(v.num) && v.bin_names?.length)
      .sort((a, b) => compareVersions(b.num, a.num))[0];
    if (selected) selected.repository ||= data.crate.repository;
  }
  assert(selected, `No installable stable version found for ${name}.`);
  const version = selected.num;
  if (previous) {
    validateManifest(previous);
    if (compareVersions(version, previous.version) < 0) return null;
    if (version === previous.version) return null;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-crate-'));
  try {
    const binaries = selected.bin_names || [];
    assert(binaries.length, `${name} has no CLI binaries.`);
    const repository = repositoryOf(selected.repository);
    assert(repository, `No supported upstream release repository for ${name}.`);
    const manifest = validateManifest({ schema: 1, name, version,
      ...(repository ? { repository } : {}),
      artifacts: await prebuilts(name, version, repository, binaries, temporary, knownRelease),
    });
    return { manifest };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function registered(directory) {
  try { return (await fs.readdir(path.join(directory, 'tools'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function main() {
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const extra = (process.env.CRATE_NAMES || '').split(/[\s,]+/).filter(Boolean);
  const readJson = async (file, fallback) => {
    try { return JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  };
  const catalog = await readJson('catalog.json', { crates: {}, unknown: [] });
  const state = await readJson('catalog-state.json', {});
  const current = {};
  for (const name of await registered(directory)) current[name] = await readJson(`tools/${name}/manifest.json`);
  assert(catalog.minimumDownloads === 10000 || !Object.keys(catalog.crates).length, 'Refresh the catalog with the 10,000-download threshold.');
  const now = Date.now();
  const requested = Number(process.env.CRATE_BATCH_SIZE || 100);
  assert(Number.isSafeInteger(requested) && requested >= 1 && requested <= 100, 'Crate batch size must be between 1 and 100.');
  const limits = await api('/rate_limit');
  const batch = publicationBudget(limits.resources.core.remaining, requested, extra.length > 0);
  const ready = Object.keys(state).filter(name => state[name].release && !current[name]).length;
  if (!extra.length && ready < batch && Object.keys(catalog.crates).length && process.env.DISCOVER_RELEASES !== 'false') {
    await probeReleases(catalog, state, current, Number(process.env.CRATE_PROBE_SIZE || 5000));
  }
  const pending = Object.keys(catalog.crates).filter(name => {
    const version = catalog.crates[name].version;
    if (current[name] && compareVersions(current[name].version, version) >= 0) return false;
    return state[name]?.version === version && state[name].release;
  });
  pending.sort((a, b) => Number(Boolean(current[b])) - Number(Boolean(current[a])) || a.localeCompare(b));
  const names = [...new Set([...extra, ...pending])].slice(0, batch);
  let changed = 0;
  const changedNames = [];
  for (const name of names) {
    assert(NAME.test(name), 'Invalid crate name.');
    const folder = path.join(directory, 'tools', name);
    try {
      const update = await generate(name, current[name], { record: extra.includes(name) ? undefined : catalog.crates[name],
        release: extra.includes(name) ? undefined : state[name]?.release });
      if (!update) { console.log(`${name} is current.`); continue; }
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(update.manifest, null, 2) + '\n');
      await fs.writeFile(path.join(folder, 'action.yml'), wrapper(name));
      delete state[name];
      console.log(`${name}: ${current[name]?.version || 'new'} -> ${update.manifest.version}`);
      changed++;
      changedNames.push(name);
    } catch (error) {
      const message = String(error.message).replace(/[\r\n]/g, ' ').slice(0, 300);
      console.log(`${name}: ${message}`);
      state[name] = { version: catalog.crates[name]?.version || null, reason: message,
        retryAfter: new Date(now + 24 * 60 * 60 * 1000).toISOString() };
      if (/HTTP (403|429)/.test(message)) break;
    }
  }
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'catalog-state.json'), JSON.stringify(state, null, 2) + '\n');
  const unprobed = Object.keys(catalog.crates).filter(name => !current[name]
    && state[name]?.version !== catalog.crates[name].version).length;
  const remaining = Math.max(0, pending.length - names.length) + unprobed;
  await fs.writeFile(path.join(directory, 'catalog-progress.json'), JSON.stringify({
    eligible: Object.keys(catalog.crates).length, remaining,
  }, null, 2) + '\n');
  console.log(`${Object.keys(catalog.crates).length} discovered; ${remaining} queued; ${changed} published candidates.`);
  if (process.env.GITHUB_OUTPUT) {
    await writeCommand(process.env.GITHUB_OUTPUT, 'changed', String(changed > 0));
    await writeCommand(process.env.GITHUB_OUTPUT, 'names', changedNames.join(' '));
    await writeCommand(process.env.GITHUB_OUTPUT, 'remaining', String(remaining));
  }
}

if (require.main === module) main().catch(failure);
module.exports = { wrapper, compareVersions, repositoryOf, generate, registered, probeReleases, publicationBudget, main };
