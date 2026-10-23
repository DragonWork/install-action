'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { assert, NAME, VERSION, sha256, download, extractBinary, archivePath, validateManifest,
  writeCommand, failure } = require('../lib/common.cjs');
const { unpackCrate, cargo } = require('../lib/crate.cjs');
const { api } = require('./github.cjs');

const TARGETS = {
  'linux-x64': ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'],
  'linux-arm64': ['aarch64-unknown-linux-musl', 'aarch64-unknown-linux-gnu'],
  'darwin-x64': ['x86_64-apple-darwin'],
  'darwin-arm64': ['aarch64-apple-darwin'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu'],
  'win32-arm64': ['aarch64-pc-windows-msvc'],
};

function wrapper(name) {
  assert(NAME.test(name), 'Invalid crate name.');
  return `name: Install ${name}
description: Install a checksum-pinned ${name} release.
inputs:
  source:
    description: Build from the pinned crate source.
    default: 'false'
  features:
    description: Cargo features (builds from source).
    default: ''
  no-default-features:
    description: Disable default Cargo features (builds from source).
    default: 'false'
  bins:
    description: Binary names to build, separated by spaces or commas.
    default: ''
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
        DW_SOURCE: \${{ inputs.source }}
        DW_FEATURES: \${{ inputs.features }}
        DW_NO_DEFAULT_FEATURES: \${{ inputs.no-default-features }}
        DW_BINS: \${{ inputs.bins }}
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

async function prebuilts(name, version, repository, binaries, temporary) {
  if (!repository) return {};
  let release;
  for (const tag of [`v${version}`, `${name}-v${version}`, `${name}-${version}`, version]) {
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
        && /\.(tar\.gz|zip)$/.test(a.name) && a.state === 'uploaded' && /^sha256:[a-f0-9]{64}$/.test(a.digest));
      if (candidates.length === 1) { asset = candidates[0]; break; }
    }
    if (!asset) continue;
    const format = asset.name.endsWith('.zip') ? 'zip' : 'tar.gz';
    const archive = path.join(temporary, `${platform}.${format}`);
    const bytes = await download(asset.browser_download_url, { expected: asset.digest.slice(7), size: asset.size });
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

async function generate(name, previous, { version: requested } = {}) {
  assert(NAME.test(name), 'Invalid crate name.');
  const data = await cratesApi(`/crates/${name}`);
  assert(data.crate.id === name, `Use the canonical crate name: ${data.crate.id}`);
  const stable = data.versions.filter(v => !v.yanked && VERSION.test(v.num)).sort((a, b) => compareVersions(b.num, a.num));
  const selected = requested ? stable.find(v => v.num === requested) : stable[0];
  assert(selected, `No installable stable version found for ${name}.`);
  const version = selected.num;
  if (previous) {
    validateManifest(previous);
    assert(compareVersions(version, previous.version) >= 0, `Refusing to downgrade ${name}.`);
    if (version === previous.version) {
      assert(previous.source.sha256 === selected.checksum, `The published source checksum changed for ${name}.`);
      return null;
    }
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-crate-'));
  try {
    const sourceUrl = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
    const source = await download(sourceUrl, { expected: selected.checksum });
    const unpacked = path.join(temporary, 'source');
    await fs.mkdir(unpacked);
    await unpackCrate(source, unpacked, `${name}-${version}`);
    const metadata = JSON.parse(await cargo(['metadata', '--no-deps', '--format-version', '1'], unpacked, { capture: true }));
    const crate = metadata.packages.find(p => p.name === name && p.version === version);
    const binaries = crate?.targets.filter(t => t.kind.includes('bin')).map(t => t.name) || [];
    assert(binaries.length, `${name} has no CLI binaries.`);
    const lockPath = path.join(unpacked, 'Cargo.lock');
    try { await fs.access(lockPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await cargo(['generate-lockfile'], unpacked);
    }
    const lock = await fs.readFile(lockPath);
    const repository = repositoryOf(selected.repository || data.crate.repository);
    const release = previous ? previous.release.replace(/\d+$/, n => String(Number(n) + 1)) : '1.0.0';
    const manifest = validateManifest({ schema: 1, name, version, release,
      ...(repository ? { repository } : {}),
      source: { url: sourceUrl, sha256: sha256(source), size: source.length, lockSha256: sha256(lock) },
      artifacts: await prebuilts(name, version, repository, binaries, temporary),
    });
    return { manifest, lock };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function registered(directory) {
  try { return (await fs.readdir(path.join(directory, 'tools'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function main() {
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const extra = (process.env.CRATE_NAMES || '').split(/[\s,]+/).filter(Boolean);
  const names = [...new Set([...(await registered(directory)), ...extra])].sort();
  assert(names.length, 'Provide CRATE_NAMES to register a CLI crate.');
  let changed = 0;
  for (const name of names) {
    assert(NAME.test(name), 'Invalid crate name.');
    const folder = path.join(directory, 'tools', name);
    let previous;
    try { previous = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const update = await generate(name, previous, { version: process.env.CRATE_VERSION || undefined });
    if (!update) { console.log(`${name} is current.`); continue; }
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(update.manifest, null, 2) + '\n');
    await fs.writeFile(path.join(folder, 'Cargo.lock'), update.lock);
    await fs.writeFile(path.join(folder, 'action.yml'), wrapper(name));
    console.log(`${name}: ${previous?.version || 'new'} -> ${update.manifest.version}`);
    changed++;
  }
  if (process.env.GITHUB_OUTPUT) await writeCommand(process.env.GITHUB_OUTPUT, 'changed', String(changed > 0));
}

if (require.main === module) main().catch(failure);
module.exports = { wrapper, compareVersions, repositoryOf, generate, registered, main };
