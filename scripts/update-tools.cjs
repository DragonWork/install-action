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
const { popularity } = require('./popularity.cjs');

const TARGETS = {
  'linux-x64': ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'],
  'linux-arm64': ['aarch64-unknown-linux-musl', 'aarch64-unknown-linux-gnu'],
  'darwin-x64': ['x86_64-apple-darwin'],
  'darwin-arm64': ['aarch64-apple-darwin'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnu'],
  'win32-arm64': ['aarch64-pc-windows-msvc'],
};
const RESOLVER_REVISION = 2;

function assetFormat(name) {
  if (name.endsWith('.zip')) return 'zip';
  if (name.endsWith('.tar.xz')) return 'tar.xz';
  if (name.endsWith('.tar.zst')) return 'tar.zst';
  if (/\.(tar\.gz|tgz)$/.test(name)) return 'tar.gz';
  if (!/installer|setup/i.test(name) && /(?:\.exe|[_.]bin)$/i.test(name)) return 'binary';
  return null;
}

function nativeBinary(bytes, platform) {
  if (bytes.length < 32) return false;
  if (platform.startsWith('linux-')) return bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]));
  if (platform.startsWith('win32-')) return bytes.subarray(0, 2).toString() === 'MZ';
  return ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.subarray(0, 4).toString('hex'));
}

function assetCandidates(assets, platform, name, binaries) {
  const targets = TARGETS[platform];
  const arch = platform.endsWith('-x64') ? /(?:^|[-_.])(x86_64|amd64|x64)(?:[-_.]|$)/i
    : /(?:^|[-_.])(aarch64|arm64)(?:[-_.]|$)/i;
  const os = platform.startsWith('linux-') ? /(?:^|[-_.])linux(?:[-_.]|$)/i
    : platform.startsWith('darwin-') ? /(?:^|[-_.])(darwin|macos|osx)(?:[-_.]|$)/i
      : /(?:^|[-_.])(windows|win32|win64)(?:[-_.]|$)/i;
  const names = [...new Set([name, ...binaries])];
  const prefix = asset => names.some(binary => asset.name.startsWith(binary + '-')
    || asset.name.startsWith(binary + '_') || asset.name.startsWith(binary + '.')) ? 0 : 1;
  const order = platform.startsWith('win32-') ? ['zip', 'tar.gz', 'tar.xz', 'tar.zst', 'binary']
    : ['tar.gz', 'tar.xz', 'tar.zst', 'zip', 'binary'];
  const rank = asset => {
    const target = targets.findIndex(value => asset.name.includes(value));
    return target >= 0 ? target : targets.length;
  };
  const stem = asset => asset.name.replace(/\.(?:tar\.(?:gz|xz|zst)|tgz|zip|exe)$/, '');
  return assets.filter(asset => asset.state === 'uploaded' && assetFormat(asset.name)
    && !/linux[-_.](?:android|androideabi)(?:[-_.]|$)/i.test(asset.name)
    && (targets.some(target => asset.name.includes(target)) || (arch.test(asset.name) && os.test(asset.name))))
    .sort((a, b) => rank(a) - rank(b) || prefix(a) - prefix(b)
      || Number(assetFormat(a.name) === 'binary') - Number(assetFormat(b.name) === 'binary')
      || stem(a).length - stem(b).length
      || order.indexOf(assetFormat(a.name)) - order.indexOf(assetFormat(b.name))
      || a.name.localeCompare(b.name));
}

async function probeReleases(catalog, state, current, limit = 2000) {
  const now = Date.now();
  const due = Object.keys(catalog.crates).filter(name => {
    const version = catalog.crates[name].version;
    if (current[name] && compareVersions(current[name].version, version) >= 0) return false;
    return state[name]?.version !== version || state[name]?.resolverRevision !== RESOLVER_REVISION
      || Date.parse(state[name].retryAfter || 0) <= now;
  });
  due.sort((a, b) => Number(Boolean(current[b])) - Number(Boolean(current[a]))
    || Number(Boolean(state[a])) - Number(Boolean(state[b]))
    || popularity(catalog.crates[b]) - popularity(catalog.crates[a]) || a.localeCompare(b));
  const requests = [];
  const retryAfter = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  for (const name of due) {
    const entry = catalog.crates[name];
    const repository = repositoryOf(entry.repository);
    if (!repository) {
      state[name] = { version: entry.version, resolverRevision: RESOLVER_REVISION, reason: 'No GitHub release repository.', retryAfter };
      continue;
    }
    if (requests.length < limit) requests.push({ name, entry, repository });
  }
  for (let offset = 0; offset < requests.length; offset += 50) {
    const block = requests.slice(offset, offset + 50);
    const fields = block.map(({ name, entry, repository }, index) => {
      const [owner, repo] = repository.split('/');
      const tags = [`v${entry.version}`, `${name}-v${entry.version}`, `${name}-${entry.version}`, entry.version];
      return `r${index}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { nameWithOwner ` +
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
      const upstream = response.data[`r${index}`];
      const releases = Object.entries(upstream || {}).filter(([key, value]) => /^t\d+$/.test(key) && value).map(([, value]) => value);
      const found = releases.find(r => !r.isDraft && !r.isPrerelease
        && r.releaseAssets.nodes.some(a => assetFormat(a.name)));
      state[name] = { version: entry.version, resolverRevision: RESOLVER_REVISION, retryAfter, ...(found ? { release: {
        repository: upstream.nameWithOwner, tag_name: found.tagName,
        assets: found.releaseAssets.nodes.filter(a => assetFormat(a.name)).map(a => ({ name: a.name,
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

async function canonicalRepository(repository) {
  const [owner, name] = repository.split('/');
  const response = await api('/graphql', { method: 'POST', body: {
    query: `{ repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { nameWithOwner } }`,
  } });
  assert(!response.errors, `Repository lookup failed: ${response.errors?.[0]?.message}`);
  const canonical = response.data?.repository?.nameWithOwner;
  assert(canonical && repositoryOf(`https://github.com/${canonical}`) === canonical, 'No supported upstream release repository.');
  return canonical;
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
  for (const platform of Object.keys(TARGETS)) {
    for (const asset of assetCandidates(release.assets, platform, name, binaries)) {
      const format = assetFormat(asset.name);
      if (format === 'binary' && binaries.length !== 1) continue;
      const archive = path.join(temporary, `${platform}.${format}`);
      const expected = /^sha256:[a-f0-9]{64}$/.test(asset.digest || '') ? asset.digest.slice(7) : undefined;
      const bytes = await download(asset.browser_download_url, { expected, size: asset.size });
      const found = {};
      if (format === 'binary') {
        if (!nativeBinary(bytes, platform)) continue;
        const filename = binaries[0] + (platform.startsWith('win32-') ? '.exe' : '');
        found[filename] = { path: asset.name, sha256: sha256(bytes) };
      } else {
        await fs.writeFile(archive, bytes, { flag: 'wx' });
        try {
          const { stdout } = await execute(format === 'zip' ? 'unzip' : 'tar',
            format === 'zip' ? ['-Z1', archive] : ['-tf', archive], { maxBuffer: 8 * 1024 * 1024 });
          const paths = stdout.trim().split(/\r?\n/);
          for (const binary of binaries) {
            const filename = binary + (platform.startsWith('win32-') ? '.exe' : '');
            const matches = paths.filter(member => archivePath(member) && path.posix.basename(member) === filename);
            if (matches.length !== 1) break;
            found[filename] = { path: matches[0], sha256: sha256(await extractBinary(archive, { format, executable: matches[0] })) };
          }
        } finally { await fs.unlink(archive); }
      }
      if (Object.keys(found).length !== binaries.length) continue;
      artifacts[platform] = { url: asset.browser_download_url, releaseTag: release.tag_name,
        sha256: sha256(bytes), size: bytes.length, format, binaries: found };
      break;
    }
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
    const upstream = repositoryOf(selected.repository);
    assert(upstream, `No supported upstream release repository for ${name}.`);
    const repository = knownRelease?.repository || await canonicalRepository(upstream);
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

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function currentManifests(directory) {
  const current = Object.create(null);
  for (const name of await registered(directory)) current[name] = await readJson(path.join(directory, 'tools', name, 'manifest.json'));
  return current;
}

function duePreparation(entry, version, now = Date.now()) {
  return entry?.version === version && entry.resolverRevision === RESOLVER_REVISION && entry.release
    && (!entry.retryable || Date.parse(entry.retryAfter) <= now);
}

function catalogProgress(catalog, state, current, now = Date.now()) {
  let remaining = 0, runnable = 0;
  const deferred = [];
  for (const [name, entry] of Object.entries(catalog.crates)) {
    if (current[name] && compareVersions(current[name].version, entry.version) >= 0) continue;
    const status = state[name];
    if (!status || status.version !== entry.version || status.resolverRevision !== RESOLVER_REVISION) { remaining++; runnable++; continue; }
    if (status.release || status.retryable) {
      remaining++;
      if (!status.retryable || Date.parse(status.retryAfter) <= now) runnable++;
      else deferred.push(status.retryAfter);
    }
  }
  return { eligible: Object.keys(catalog.crates).length, remaining, runnable,
    ...(deferred.length ? { nextRetryAt: deferred.sort()[0] } : {}) };
}

async function planUpdate(directory) {
  const extra = (process.env.CRATE_NAMES || '').split(/[\s,]+/).filter(Boolean);
  const catalog = await readJson(path.join(directory, 'catalog.json'), { crates: {}, unknown: [] });
  const state = await readJson(path.join(directory, 'catalog-state.json'), {});
  for (const entry of Object.values(state)) {
    if (entry.reason === 'Invalid release asset URL.' && !entry.repositoryResolved) {
      entry.retryable = true;
      entry.retryAfter = new Date(0).toISOString();
    }
    if (entry.retryable === undefined && /HTTP (403|408|429|5\d\d)|fetch failed|timeout|timed out|aborted|ECONN|ENOTFOUND/i.test(entry.reason || '')) {
      entry.retryable = true;
      entry.retryAfter = new Date(Math.min(Date.parse(entry.retryAfter) || Infinity, Date.now() + 15 * 60 * 1000)).toISOString();
    }
  }
  const current = await currentManifests(directory);
  assert(catalog.minimumDownloads === 10000 || !Object.keys(catalog.crates).length, 'Refresh the catalog with the 10,000-download threshold.');
  const requested = Number(process.env.CRATE_BATCH_SIZE || 100);
  assert(Number.isSafeInteger(requested) && requested >= 1 && requested <= 100, 'Crate batch size must be between 1 and 100.');
  const limits = await api('/rate_limit');
  const batch = publicationBudget(limits.resources.core.remaining, requested, extra.length > 0);
  const ready = Object.keys(state).filter(name => !current[name]
    && duePreparation(state[name], catalog.crates[name]?.version)).length;
  if (!extra.length && ready < batch && Object.keys(catalog.crates).length && process.env.DISCOVER_RELEASES !== 'false') {
    await probeReleases(catalog, state, current, Number(process.env.CRATE_PROBE_SIZE || 5000));
  }
  const pending = Object.keys(catalog.crates).filter(name => {
    const version = catalog.crates[name].version;
    if (current[name] && compareVersions(current[name].version, version) >= 0) return false;
    return duePreparation(state[name], version);
  });
  pending.sort((a, b) => Number(Boolean(current[b])) - Number(Boolean(current[a]))
    || popularity(catalog.crates[b]) - popularity(catalog.crates[a]) || a.localeCompare(b));
  const names = [...new Set([...extra, ...pending])].slice(0, batch);
  for (const name of names) assert(NAME.test(name), 'Invalid crate name.');
  const plan = { names, shards: Math.min(3, names.length) || 1, candidates: Object.fromEntries(names.map(name => [name, {
    previous: current[name] || null,
    targetVersion: catalog.crates[name]?.version || null,
    ...(extra.includes(name) ? {} : { record: catalog.crates[name], release: state[name]?.release }),
  }])) };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'catalog-state.json'), JSON.stringify(state, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'update-plan.json'), JSON.stringify(plan) + '\n');
  if (process.env.GITHUB_OUTPUT) {
    await writeCommand(process.env.GITHUB_OUTPUT, 'work', String(names.length > 0));
    await writeCommand(process.env.GITHUB_OUTPUT, 'matrix', JSON.stringify(Array.from({ length: plan.shards }, (_, index) => index)));
  }
  console.log(`Planned ${names.length} tools across ${plan.shards} workers.`);
  return plan;
}

async function prepareShard(directory, output, shard, generator = generate) {
  const plan = await readJson(path.join(directory, 'update-plan.json'));
  assert(Number.isInteger(shard) && shard >= 0 && shard < plan.shards, 'Invalid preparation worker.');
  const report = { shard, attempted: [], changed: [], failures: {} };
  for (const [index, name] of plan.names.entries()) {
    if (index % plan.shards !== shard) continue;
    assert(NAME.test(name), 'Invalid crate name.');
    const candidate = plan.candidates[name];
    const folder = path.join(output, 'tools', name);
    report.attempted.push(name);
    try {
      const update = await generator(name, candidate.previous, candidate);
      if (!update) { console.log(`${name} is current.`); continue; }
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(update.manifest, null, 2) + '\n');
      await fs.writeFile(path.join(folder, 'action.yml'), wrapper(name));
      console.log(`${name}: ${candidate.previous?.version || 'new'} -> ${update.manifest.version}`);
      report.changed.push(name);
    } catch (error) {
      const message = String(error.message).replace(/[\r\n]/g, ' ').slice(0, 300);
      const retryable = /HTTP (403|408|429|5\d\d)|fetch failed|timeout|timed out|aborted|ECONN|ENOTFOUND/i.test(message);
      console.log(`${name}: ${message}`);
      report.failures[name] = { version: candidate.targetVersion, resolverRevision: RESOLVER_REVISION,
        repositoryResolved: true, reason: message, retryable,
        retryAfter: new Date(Date.now() + (retryable ? 15 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000)).toISOString(),
        ...(retryable && candidate.release ? { release: candidate.release } : {}),
      };
      if (/HTTP (403|429)/.test(message)) break;
    }
  }
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, `worker-${shard}.json`), JSON.stringify(report) + '\n');
  return report;
}

async function mergePrepared(directory, output) {
  const plan = await readJson(path.join(directory, 'update-plan.json'));
  const catalog = await readJson(path.join(directory, 'catalog.json'));
  const state = await readJson(path.join(directory, 'catalog-state.json'), {});
  const attempted = new Set(), changed = [];
  for (let shard = 0; plan.names.length && shard < plan.shards; shard++) {
    const report = await readJson(path.join(output, `worker-${shard}.json`));
    assert(report?.shard === shard, 'Missing preparation report.');
    for (const name of report.attempted) {
      const index = plan.names.indexOf(name);
      assert(index >= 0 && index % plan.shards === shard && !attempted.has(name), 'Preparation workers overlap or changed an unplanned tool.');
      attempted.add(name);
      if (Object.hasOwn(report.failures, name)) state[name] = report.failures[name];
      else delete state[name];
    }
    for (const name of report.changed) {
      assert(report.attempted.includes(name) && !Object.hasOwn(report.failures, name), 'Invalid prepared result.');
      const source = path.join(output, 'tools', name);
      const manifest = validateManifest(await readJson(path.join(source, 'manifest.json')));
      assert(manifest.name === name, 'Prepared manifest has the wrong crate name.');
      if (plan.candidates[name].record) assert(manifest.version === plan.candidates[name].record.version, 'Prepared manifest has the wrong crate version.');
      const destination = path.join(directory, 'tools', name);
      await fs.mkdir(destination, { recursive: true });
      for (const file of ['manifest.json', 'action.yml']) await fs.copyFile(path.join(source, file), path.join(destination, file));
      changed.push(name);
    }
  }
  await require('./check.cjs').checkRegistry(directory);
  const progress = catalogProgress(catalog, state, await currentManifests(directory));
  await fs.writeFile(path.join(directory, 'catalog-state.json'), JSON.stringify(state, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'catalog-progress.json'), JSON.stringify(progress, null, 2) + '\n');
  console.log(`${progress.eligible} eligible; ${progress.remaining} remaining; ${changed.length} prepared.`);
  if (process.env.GITHUB_OUTPUT) {
    await writeCommand(process.env.GITHUB_OUTPUT, 'changed', String(changed.length > 0));
    await writeCommand(process.env.GITHUB_OUTPUT, 'names', changed.join(' '));
    await writeCommand(process.env.GITHUB_OUTPUT, 'remaining', String(progress.remaining));
  }
  return progress;
}

async function main() {
  const directory = path.resolve(process.env.CRATES_DIR || 'registry');
  const output = path.resolve(process.env.PREPARED_DIR || 'prepared');
  const phase = process.argv[2] || 'all';
  if (phase === 'plan') return planUpdate(directory);
  if (phase === 'prepare') return prepareShard(directory, output, Number(process.env.SHARD_INDEX));
  if (phase === 'merge') return mergePrepared(directory, output);
  assert(phase === 'all', 'Unknown update phase.');
  const plan = await planUpdate(directory);
  for (let shard = 0; shard < plan.shards; shard++) await prepareShard(directory, output, shard);
  return mergePrepared(directory, output);
}

if (require.main === module) main().catch(failure);
module.exports = { wrapper, compareVersions, repositoryOf, generate, registered, probeReleases, publicationBudget,
  assetFormat, assetCandidates, nativeBinary,
  catalogProgress, planUpdate, prepareShard, mergePrepared, main };
