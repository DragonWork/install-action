'use strict';

const { gzipSync } = require('node:zlib');
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

module.exports = { tar, sample };
