'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogIndex } = require('../scripts/build-catalog.cjs');
const { sample } = require('./fixtures.cjs');
const { popularity } = require('../scripts/popularity.cjs');

test('catalog readers queue with publishers so branch contents and tags stay consistent', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  for (const name of ['pages.yml', 'update-crates.yml', 'backfill-version.yml']) {
    const workflow = await fs.readFile(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
    const concurrency = workflow.match(/^concurrency:\n((?:[ \t]+[^\n]*\n)+)/m)?.[1];
    assert(concurrency, `Missing publication queue in ${name}`);
    assert.match(concurrency, /^  group: crate-publication$/m, name);
    assert.match(concurrency, /^  queue: max$/m, name);
    assert.match(concurrency, /^  cancel-in-progress: false$/m, name);
  }
});

test('catalog pins come from installer and tool version tags, with yank status retained', () => {
  const { manifest } = sample();
  const refs = new Map([
    ['v1.0.3', 'a'.repeat(40)], ['v1.1.0', 'b'.repeat(40)],
    ['sample-cli/v1.0.0', 'c'.repeat(40)], ['other/v99.0.0', 'd'.repeat(40)],
  ]);
  const data = catalogIndex([manifest], refs, { schema: 2, yanked: { 'sample-cli': ['1.0.0'] } });
  assert.deepEqual(data.engine, { version: '1.1.0', sha: 'b'.repeat(40) });
  assert.equal(data.tools[0].sha, 'c'.repeat(40));
  assert.equal(data.tools[0].yanked, true);
  refs.delete('sample-cli/v1.0.0');
  assert.throws(() => catalogIndex([manifest], refs, { schema: 2, yanked: {} }), /Missing version tag/);
  manifest.name = 'constructor';
  refs.set('constructor/v1.0.0', 'e'.repeat(40));
  assert.equal(catalogIndex([manifest], refs, { schema: 2, yanked: {} }).tools[0].yanked, false);
});

test('search combines crate names, executable names, and platform filters', async () => {
  const { filterTools } = await import('../site/catalog.mjs');
  const tools = [
    { name: 'git-cliff', binaries: ['git-cliff', 'git-cliff-mangen'], platforms: ['linux-x64', 'darwin-arm64'], popularity: 2 },
    { name: 'b3sum', binaries: ['b3sum'], platforms: ['linux-x64'], popularity: 1 },
  ];
  assert.deepEqual(filterTools(tools, ' GIT cliff ', 'darwin-arm64'), [tools[0]]);
  assert.deepEqual(filterTools(tools, 'mangen', ''), [tools[0]]);
  assert.deepEqual(filterTools(tools, 'b3sum', 'darwin-arm64'), []);
  assert.deepEqual(filterTools(tools, '', ''), tools);
  assert.deepEqual(filterTools(tools, '', '', 'name'), [tools[1], tools[0]]);
});

test('popularity favors current use, retains lifetime use, and caps release activity', () => {
  const active = { recentDownloads: 10000, downloads: 100000, recentVersions: 4 };
  const dormant = { recentDownloads: 10, downloads: 1000000, recentVersions: 0 };
  assert(popularity(active) > popularity(dormant));
  assert(popularity({ ...active, downloads: 200000 }) > popularity(active));
  assert(popularity(active) > popularity({ ...active, recentVersions: 0 }));
  assert.equal(popularity({ ...active, recentVersions: 12 }), popularity({ ...active, recentVersions: 10000 }));
  assert.equal(popularity({ downloads: -1, recentDownloads: NaN }), 0);
  const { manifest } = sample();
  const other = { ...manifest, name: 'another-cli' };
  const refs = new Map([['v1.1.0', 'a'.repeat(40)], ['sample-cli/v1.0.0', 'b'.repeat(40)], ['another-cli/v1.0.0', 'c'.repeat(40)]]);
  const index = catalogIndex([manifest, other], refs, { schema: 3, yanked: {}, crates: {
    'sample-cli': active, 'another-cli': dormant,
  } });
  assert.deepEqual(index.tools.map(tool => tool.name), ['sample-cli', 'another-cli']);
  assert.equal(index.tools[0].recentDownloads, active.recentDownloads);
});

test('copyable steps use independent full SHAs and reject malformed references', async () => {
  const { installationSteps } = await import('../site/catalog.mjs');
  const engine = { version: '1.1.0', sha: 'a'.repeat(40) };
  const tool = { name: 'git-cliff', version: '2.14.2', sha: 'b'.repeat(40) };
  const snippet = installationSteps(engine, tool);
  assert(snippet.includes(`DragonWork/install-action@${engine.sha} # v1.1.0`));
  assert(snippet.includes(`DragonWork/install-action/tools/git-cliff@${tool.sha} # git-cliff/v2.14.2`));
  assert.throws(() => installationSteps(engine, { ...tool, sha: 'main' }));
  assert.throws(() => installationSteps(engine, { ...tool, name: 'git-cliff\nrun: injected' }));
});
