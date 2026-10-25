'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_BINARY = 256 * 1024 * 1024;
const PLATFORMS = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function archivePath(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(value)) return false;
  const relative = value.replace(/^(\.\/)+/, '');
  return !relative.startsWith('/') && !relative.startsWith('-')
    && relative.split('/').every(part => part !== '..' && part !== '.' && part !== '');
}

function releaseTags(name, version) {
  const versions = [version];
  if (version.endsWith('.0')) versions.push(version.slice(0, -2));
  return versions.flatMap(value => [`v${value}`, `${name}-v${value}`, `${name}-${value}`, value,
    `${name}/v${value}`, `${name}/${value}`, `${name}@${value}`]);
}

function validateManifest(manifest) {
  assert(manifest && manifest.schema === 1, 'Unsupported manifest schema; update the installer.');
  assert(NAME.test(manifest.name), 'Invalid tool name.');
  assert(VERSION.test(manifest.version), 'An exact stable tool version is required.');
  assert(manifest.artifacts && Object.keys(manifest.artifacts).length > 0, 'No prebuilt platform artifacts.');
  for (const [platform, artifact] of Object.entries(manifest.artifacts)) {
    assert(PLATFORMS.has(platform), `Unsupported platform: ${platform}`);
    const url = new URL(artifact.url);
    assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(manifest.repository), 'Invalid upstream repository.');
    assert(releaseTags(manifest.name, manifest.version).includes(artifact.releaseTag), 'Invalid artifact release tag.');
    const prefix = `/${manifest.repository}/releases/download/`;
    const asset = url.pathname.slice(prefix.length);
    const separator = asset.lastIndexOf('/');
    assert(url.protocol === 'https:' && url.hostname === 'github.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(prefix) && separator > 0 && separator < asset.length - 1
      && decodeURIComponent(asset.slice(0, separator)) === artifact.releaseTag, 'Invalid release asset URL.');
    assert(SHA256.test(artifact.sha256), 'Missing or invalid archive SHA-256.');
    assert(Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= MAX_ARCHIVE, 'Invalid archive size.');
    assert(['tar.gz', 'tar.xz', 'tar.zst', 'tar.bz2', 'tar', 'zip', 'binary', 'deb'].includes(artifact.format), 'Unsupported archive format.');
    assert(artifact.binaries && Object.keys(artifact.binaries).length > 0, 'No executable files.');
    for (const [name, binary] of Object.entries(artifact.binaries)) {
      assert(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/.test(name), 'Invalid executable name.');
      assert(archivePath(binary.path) && SHA256.test(binary.sha256), 'Invalid executable path or SHA-256.');
    }
  }
  return manifest;
}

async function download(url, { expected, size, fetcher = fetch, limit = MAX_ARCHIVE } = {}) {
  const signal = AbortSignal.timeout(120_000);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    assert(parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password
      && (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.githubusercontent.com')), 'Untrusted asset host.');
    response = await fetcher(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    assert(location && redirects < 5, 'Too many or invalid asset redirects.');
    url = new URL(location, url).href;
  }
  assert(response.ok && response.body, `Asset download failed: HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  assert(!declared || Number(declared) <= limit, 'Archive exceeds the size limit.');
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      assert(length <= limit, 'Archive exceeds the size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks, length);
  assert(!size || length === size, 'Archive size does not match the manifest.');
  assert(!expected || sha256(bytes) === expected, 'Archive SHA-256 does not match the manifest.');
  return bytes;
}

async function withArchive(archive, format, callback) {
  if (format !== 'deb') return callback(archive, format);
  const bytes = await fs.readFile(archive);
  assert(bytes.length <= MAX_ARCHIVE && bytes.subarray(0, 8).toString() === '!<arch>\n', 'Invalid Debian archive.');
  let payload;
  for (let offset = 8; offset < bytes.length;) {
    assert(offset + 60 <= bytes.length && bytes.subarray(offset + 58, offset + 60).toString() === '`\n', 'Invalid Debian member.');
    const name = bytes.subarray(offset, offset + 16).toString().trim().replace(/\/$/, '');
    const field = bytes.subarray(offset + 48, offset + 58).toString().trim();
    assert(/^\d+$/.test(field), 'Invalid Debian member size.');
    const size = Number(field), start = offset + 60;
    assert(Number.isSafeInteger(size) && start + size <= bytes.length, 'Truncated Debian member.');
    if (/^data\.tar(?:\.(?:gz|xz|zst|bz2))?$/.test(name)) {
      assert(!payload, 'Ambiguous Debian data archive.');
      payload = { name, bytes: bytes.subarray(start, start + size) };
    }
    offset = start + size + size % 2;
    assert(offset <= bytes.length, 'Truncated Debian padding.');
  }
  assert(payload, 'No supported Debian data archive.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'install-action-deb-'));
  try {
    const file = path.join(directory, payload.name);
    await fs.writeFile(file, payload.bytes, { flag: 'wx' });
    return await callback(file, 'tar');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function archiveCommand(format) {
  const zip = format === 'zip' && process.platform !== 'win32';
  return { zip, command: process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : zip ? 'unzip' : 'tar' };
}

async function windowsZip(archive, member) {
  const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execute(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'read-zip.ps1'), '-Archive', archive,
    ...(member === undefined ? [] : ['-Member', member])], {
    encoding: member === undefined ? 'utf8' : 'buffer',
    maxBuffer: member === undefined ? 8 * 1024 * 1024 : MAX_BINARY,
    timeout: 60_000, windowsHide: true,
  });
}

async function archiveEntries(archive, format) {
  return withArchive(archive, format, async (file, inner) => {
    if (inner === 'zip' && process.platform === 'win32') {
      const { stdout } = await windowsZip(file);
      return JSON.parse(stdout);
    }
    const { command, zip } = archiveCommand(inner);
    const { stdout } = await execute(command, zip ? ['-Z1', file] : ['-tf', file], {
      maxBuffer: 8 * 1024 * 1024, timeout: 60_000, windowsHide: true,
    });
    return stdout.trim().split(/\r?\n/);
  });
}

async function extractBinary(archive, artifact) {
  assert(archivePath(artifact.executable), 'Unsafe executable path.');
  if (artifact.format === 'binary') {
    const bytes = await fs.readFile(archive);
    assert(bytes.length > 0 && bytes.length <= MAX_BINARY, 'Invalid executable size.');
    assert(!artifact.binarySha256 || sha256(bytes) === artifact.binarySha256, 'Executable SHA-256 does not match the manifest.');
    return bytes;
  }
  return withArchive(archive, artifact.format, async (file, format) => {
    if (format === 'zip' && process.platform === 'win32') {
      const { stdout } = await windowsZip(file, artifact.executable);
      assert(stdout.length > 0, 'The archive does not contain the executable.');
      assert(!artifact.binarySha256 || sha256(stdout) === artifact.binarySha256, 'Executable SHA-256 does not match the manifest.');
      return stdout;
    }
    const { command, zip } = archiveCommand(format);
    const args = zip ? ['-p', file, artifact.executable] : ['-xOf', file, '--', artifact.executable];
    const { stdout } = await execute(command, args, {
      encoding: 'buffer', maxBuffer: MAX_BINARY, timeout: 60_000, windowsHide: true,
    });
    assert(stdout.length > 0, 'The archive does not contain the executable.');
    assert(!artifact.binarySha256 || sha256(stdout) === artifact.binarySha256, 'Executable SHA-256 does not match the manifest.');
    return stdout;
  });
}

async function writeCommand(file, name, value) {
  assert(file, 'This command must run inside GitHub Actions.');
  assert(!/[\r\n]/.test(name + value), 'Invalid workflow command value.');
  await fs.appendFile(file, `${name}=${value}${os.EOL}`);
}

async function ownedDirectory(directory, parent, prefix) {
  assert(directory && parent && path.isAbsolute(directory), 'Invalid installation directory.');
  const parentReal = await fs.realpath(parent);
  const stat = await fs.lstat(directory);
  const real = await fs.realpath(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && path.dirname(real) === parentReal
    && path.basename(real).startsWith(prefix), 'Unsafe installation directory.');
  assert(!process.getuid || stat.uid === process.getuid(), 'Installation directory has a different owner.');
  return real;
}

function failure(error) {
  console.error(String(error.message).replace(/[\r\n]/g, ' '));
  process.exitCode = 1;
}

module.exports = { assert, sha256, archivePath, validateManifest, download, extractBinary,
  archiveEntries, releaseTags, writeCommand, ownedDirectory, failure, VERSION, NAME, PLATFORMS };
