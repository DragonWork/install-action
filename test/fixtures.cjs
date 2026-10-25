'use strict';

const { gzipSync, deflateRawSync } = require('node:zlib');
const { sha256 } = require('../lib/common.cjs');

function tar(files) {
  const blocks = [];
  for (const [name, raw] of Object.entries(files)) {
    const entry = typeof raw === 'object' && !Buffer.isBuffer(raw) ? raw : { content: raw };
    const data = Buffer.from(entry.content || '');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(entry.type || '0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function sample() {
  const binary = Buffer.from('#!/bin/sh\nprintf "sample-cli 1.0.0\\n"\n');
  const archive = tar({ 'sample-cli-1.0.0/sample-cli': binary });
  const manifest = {
    schema: 1, name: 'sample-cli', version: '1.0.0', repository: 'example/sample-cli',
    artifacts: { 'linux-x64': {
      url: 'https://github.com/example/sample-cli/releases/download/v1.0.0/sample-cli.tar.gz',
      releaseTag: 'v1.0.0', sha256: sha256(archive), size: archive.length, format: 'tar.gz',
      binaries: { 'sample-cli': { path: 'sample-cli-1.0.0/sample-cli', sha256: sha256(binary) } },
    } },
  };
  const fetcher = async () => new Response(archive);
  return { binary, archive, manifest, fetcher };
}

function executable(platform) {
  const bytes = Buffer.alloc(128);
  if (platform.startsWith('linux-')) {
    bytes.set([127, 69, 76, 70, 2, 1, 1]);
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(platform.endsWith('x64') ? 62 : 183, 18);
  } else if (platform.startsWith('darwin-')) {
    bytes.set([207, 250, 237, 254]);
    bytes.writeUInt32LE(platform.endsWith('x64') ? 0x1000007 : 0x100000c, 4);
    bytes.writeUInt32LE(2, 12);
  } else {
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.write('PE\0\0', 64);
    bytes.writeUInt16LE(platform.endsWith('x64') ? 0x8664 : 0xaa64, 68);
    bytes.writeUInt16LE(2, 86);
  }
  return bytes;
}

function universal(wide = false) {
  const width = wide ? 32 : 20, start = 8 + width * 2;
  const bytes = Buffer.alloc(start + 256);
  bytes.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  bytes.writeUInt32BE(2, 4);
  for (const [index, platform] of ['darwin-x64', 'darwin-arm64'].entries()) {
    const entry = 8 + width * index, offset = start + index * 128;
    bytes.writeUInt32BE(index ? 0x100000c : 0x1000007, entry);
    if (wide) {
      bytes.writeBigUInt64BE(BigInt(offset), entry + 8);
      bytes.writeBigUInt64BE(128n, entry + 16);
    } else {
      bytes.writeUInt32BE(offset, entry + 8);
      bytes.writeUInt32BE(128, entry + 12);
    }
    executable(platform).copy(bytes, offset);
  }
  return bytes;
}

function ar(files) {
  return Buffer.concat([Buffer.from('!<arch>\n'), ...Object.entries(files).flatMap(([name, bytes]) => [
    Buffer.from(name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6)
      + '100644'.padEnd(8) + String(bytes.length).padEnd(10) + '`\n'),
    bytes, Buffer.alloc(bytes.length % 2, 10),
  ])]);
}

function zip(files, compressed = true) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(raw);
    const data = compressed ? deflateRawSync(bytes) : bytes;
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), entry = Buffer.alloc(46), descriptor = Buffer.alloc(16);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x808, 6); // UTF-8 names and streaming data descriptor.
    header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt16LE(filename.length, 26);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(bytes.length, 12);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    header.copy(entry, 8, 6, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, filename, data, descriptor);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

module.exports = { tar, sample, executable, universal, ar, zip };
