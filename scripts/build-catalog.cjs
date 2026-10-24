'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assert, VERSION, validateManifest, failure } = require('../lib/common.cjs');
const { checkRegistry } = require('./check.cjs');
const { compareVersions } = require('./update-tools.cjs');
const { popularity } = require('./popularity.cjs');

async function tagRefs() {
  const { stdout } = await promisify(execFile)('git', ['for-each-ref',
    '--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)', 'refs/tags'], { maxBuffer: 8 * 1024 * 1024 });
  return new Map(stdout.trim().split('\n').filter(Boolean).map(line => {
    const [name, sha, peeled] = line.split('\t');
    return [name, peeled || sha];
  }));
}

function catalogIndex(manifests, refs, catalog) {
  assert([2, 3].includes(catalog.schema) && catalog.yanked && typeof catalog.yanked === 'object'
    && !Array.isArray(catalog.yanked), 'Refresh the catalog with yank metadata before building the site.');
  const versions = [...refs.keys()].filter(tag => tag.startsWith('v') && VERSION.test(tag.slice(1)))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  assert(versions.length, 'No published installer tag.');
  const engine = { version: versions[0].slice(1), sha: refs.get(versions[0]) };
  assert(/^[a-f0-9]{40}$/.test(engine.sha), 'Invalid installer commit.');
  const tools = manifests.map(manifest => {
    validateManifest(manifest);
    const sha = refs.get(`${manifest.name}/v${manifest.version}`);
    assert(/^[a-f0-9]{40}$/.test(sha || ''), `Missing version tag for ${manifest.name}.`);
    const yanked = Object.hasOwn(catalog.yanked, manifest.name) ? catalog.yanked[manifest.name] : [];
    const stats = Object.hasOwn(catalog.crates || {}, manifest.name) ? catalog.crates[manifest.name] : {};
    assert(Array.isArray(yanked) && yanked.every(version => typeof version === 'string' && VERSION.test(version)), 'Invalid yank metadata.');
    return {
      name: manifest.name, version: manifest.version, sha,
      platforms: Object.keys(manifest.artifacts).sort(),
      binaries: [...new Set(Object.values(manifest.artifacts).flatMap(artifact =>
        Object.keys(artifact.binaries).map(name => name.replace(/\.exe$/, ''))))].sort(),
      yanked: yanked.includes(manifest.version),
      popularity: popularity(stats),
      recentDownloads: stats.recentDownloads ?? null,
    };
  }).sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name, 'en'));
  assert(new Set(tools.map(tool => tool.name)).size === tools.length, 'Duplicate catalog tool.');
  return { schema: 1, updatedAt: catalog.modified || null, engine, tools };
}

async function buildCatalog({ directory = path.resolve('registry'), output = path.resolve('_site'), refs } = {}) {
  const names = await checkRegistry(directory);
  const manifests = [];
  for (const name of names) manifests.push(JSON.parse(await fs.readFile(path.join(directory, 'tools', name, 'manifest.json'), 'utf8')));
  const catalog = JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'));
  const index = catalogIndex(manifests, refs || await tagRefs(), catalog);
  const assets = ['index.html', 'style.css', 'catalog.mjs'];
  const allowed = new Set([...assets, 'tools.json', '.nojekyll']);
  await fs.mkdir(output, { recursive: true });
  const stat = await fs.lstat(output);
  assert(stat.isDirectory() && !stat.isSymbolicLink()
    && (!process.getuid || stat.uid === process.getuid()), 'Unsafe site output directory.');
  const destination = await fs.realpath(output);
  assert(destination !== await fs.realpath(path.join(__dirname, '..', 'site'))
    && destination !== await fs.realpath(directory), 'Site output must not overwrite its source.');
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    assert(allowed.has(entry.name) && entry.isFile(), 'Site output contains unrelated files.');
  }
  for (const file of assets) await fs.copyFile(path.join(__dirname, '..', 'site', file), path.join(output, file));
  await fs.writeFile(path.join(output, 'tools.json'), JSON.stringify(index) + '\n');
  await fs.writeFile(path.join(output, '.nojekyll'), '');
  console.log(`Built catalog: ${index.tools.length} tools; installer v${index.engine.version}.`);
  return index;
}

if (require.main === module) buildCatalog({
  directory: path.resolve(process.env.CRATES_DIR || 'registry'),
  output: path.resolve(process.env.SITE_DIR || '_site'),
}).catch(failure);
module.exports = { catalogIndex, buildCatalog, tagRefs };
