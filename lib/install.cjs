'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { assert, validateManifest, download, extractBinary, ownedDirectory, writeCommand, failure } = require('./common.cjs');
const { checkYanked } = require('./yank.cjs');

async function install(manifest, root, { platform = `${process.platform}-${process.arch}`, fetcher } = {}) {
  validateManifest(manifest);
  const artifact = manifest.artifacts[platform];
  assert(artifact, `No pinned prebuilt binary for ${manifest.name} ${manifest.version} on ${platform}.`);
  const temporary = await fs.mkdtemp(path.join(root, `${manifest.name}-`));
  try {
    const archive = path.join(temporary, `archive.${artifact.format}`);
    await fs.writeFile(archive, await download(artifact.url, {
      expected: artifact.sha256, size: artifact.size, fetcher,
    }), { flag: 'wx', mode: 0o600 });
    const bin = path.join(temporary, 'bin');
    await fs.mkdir(bin, { mode: 0o700 });
    for (const [name, entry] of Object.entries(artifact.binaries)) {
      const binary = await extractBinary(archive, {
        format: artifact.format, executable: entry.path, binarySha256: entry.sha256,
      });
      await fs.writeFile(path.join(bin, name), binary, { flag: 'wx', mode: 0o755 });
    }
    await fs.unlink(archive);
    return { bin, version: manifest.version };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  assert(process.env.DW_INSTALL_PROTOCOL === '1', 'Run DragonWork/install-action before installing tools.');
  const root = await ownedDirectory(process.env.DW_INSTALL_ROOT, process.env.DW_INSTALL_PARENT, 'dragonwork-install-');
  assert(process.argv.length === 3, 'Expected one manifest path.');
  const manifest = validateManifest(JSON.parse(await fs.readFile(process.argv[2], 'utf8')));
  await checkYanked(manifest);
  const result = await install(manifest, root);
  assert(process.env.GITHUB_PATH, 'Missing GITHUB_PATH.');
  assert(!/[\r\n]/.test(result.bin), 'Invalid installation path.');
  await fs.appendFile(process.env.GITHUB_PATH, result.bin + os.EOL);
  await writeCommand(process.env.GITHUB_OUTPUT, 'version', result.version);
  await writeCommand(process.env.GITHUB_OUTPUT, 'path', result.bin);
  console.log(`Installed ${manifest.name} ${result.version}`);
}

if (require.main === module) main().catch(failure);
module.exports = { install, main };
