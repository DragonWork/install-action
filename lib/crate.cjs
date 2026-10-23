'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { assert, sha256 } = require('./common.cjs');

function sourcePath(name) {
  return name && !/[\\:\x00-\x1f\x7f]/.test(name) && !name.startsWith('/')
    && name.split('/').every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

// Crates contain ordinary files and directories. Never create archive links.
async function unpackCrate(compressed, destination, prefix) {
  const bytes = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
  const seen = new Set();
  let total = 0;
  let nextName;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const namePrefix = string(257, 263) === 'ustar' ? string(345, 500) : '';
    let name = [namePrefix, string(0, 100)].filter(Boolean).join('/').replace(/\/$/, '');
    const type = header[156];
    const sizeText = string(124, 136).trim();
    assert(/^[0-7]+$/.test(sizeText), 'Invalid crate entry size.');
    const size = Number.parseInt(sizeText, 8);
    const expected = Number.parseInt(string(148, 156).trim(), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    assert(checksum === expected, 'Invalid crate archive header.');
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length, 'Invalid crate archive size.');
    if (type === 76) {
      assert(!nextName && size <= 4096, 'Invalid long crate archive name.');
      nextName = bytes.subarray(offset + 512, offset + 512 + size).toString('utf8').replace(/\0.*$/s, '');
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 120) {
      assert(size <= 65536 && !nextName, 'Invalid extended crate header.');
      const records = bytes.subarray(offset + 512, offset + 512 + size);
      for (let cursor = 0; cursor < records.length;) {
        const space = records.indexOf(32, cursor);
        assert(space > cursor, 'Invalid extended crate record.');
        const length = Number(records.subarray(cursor, space).toString());
        assert(Number.isSafeInteger(length) && length > space - cursor + 1 && cursor + length <= records.length, 'Invalid extended crate record size.');
        const record = records.subarray(space + 1, cursor + length).toString('utf8');
        assert(record.endsWith('\n'), 'Invalid extended crate record terminator.');
        if (record.startsWith('path=')) nextName = record.slice(5, -1);
        cursor += length;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    if (nextName) { name = nextName.replace(/\/$/, ''); nextName = undefined; }
    assert(sourcePath(name) && (name === prefix || name.startsWith(prefix + '/')), 'Unsafe crate archive path.');
    assert(type === 0 || type === 48 || type === 53, 'Unsupported crate archive entry (links are forbidden).');
    assert(!seen.has(name), 'Duplicate crate archive entry.');
    seen.add(name);
    assert(seen.size <= 100_000 && Number.isSafeInteger(size) && size >= 0
      && offset + 512 + size <= bytes.length, 'Invalid crate archive size.');
    total += size;
    assert(total <= 512 * 1024 * 1024, 'Crate exceeds the extraction limit.');
    const relative = name.slice(prefix.length + 1);
    if (relative) {
      const output = path.join(destination, relative);
      await fs.mkdir(path.dirname(output), { recursive: true });
      if (type === 53) await fs.mkdir(output, { recursive: true });
      else await fs.writeFile(output, bytes.subarray(offset + 512, offset + 512 + size), {
        flag: 'wx', mode: 0o644 | (Number.parseInt(string(100, 108).trim(), 8) & 0o111),
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(seen.has(`${prefix}/Cargo.toml`), 'Crate has no Cargo.toml.');
}

function cargo(args, cwd, { capture = false, target } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, {
      cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', windowsHide: true,
      env: { ...process.env, CARGO_BUILD_JOBS: '3', ...(target ? { CARGO_TARGET_DIR: target } : {}) },
    });
    let output = '';
    child.stdout?.on('data', bytes => {
      output += bytes;
      if (output.length > 16 * 1024 * 1024) child.kill();
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`cargo ${args[0]} failed (${code}); check Rust and native build dependencies.`)));
  });
}

async function installSource(manifest, source, lock, destination, options = {}) {
  assert(sha256(source) === manifest.source.sha256, 'Crate SHA-256 does not match the manifest.');
  assert(sha256(lock) === manifest.source.lockSha256, 'Cargo.lock SHA-256 does not match the manifest.');
  const unpacked = path.join(destination, 'source');
  await fs.mkdir(unpacked);
  await unpackCrate(source, unpacked, `${manifest.name}-${manifest.version}`);
  await fs.writeFile(path.join(unpacked, 'Cargo.lock'), lock);
  const target = path.join(destination, 'target');
  const installRoot = path.join(destination, 'installed');
  const args = ['install', '--path', unpacked, '--locked', '--root', installRoot, '--jobs', '3'];
  if (options.features) args.push('--features', options.features);
  if (options.noDefaultFeatures) args.push('--no-default-features');
  if (options.bins) for (const bin of options.bins) args.push('--bin', bin);
  await cargo(args, unpacked, { target });
  const bin = path.join(installRoot, 'bin');
  const entries = await fs.readdir(bin, { withFileTypes: true });
  assert(entries.some(entry => entry.isFile()), 'Crate did not install any binaries.');
  // These exact directories belong to this successful installation only.
  await fs.rm(target, { recursive: true, force: true });
  await fs.rm(unpacked, { recursive: true });
  return bin;
}

module.exports = { unpackCrate, cargo, installSource };
