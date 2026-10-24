'use strict';

function machoPlatform(bytes) {
  if (bytes.length < 32) return;
  const magic = bytes.subarray(0, 4).toString('hex');
  if (!['cffaedfe', 'feedfacf'].includes(magic)) return;
  const read = offset => magic === 'cffaedfe' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (read(12) !== 2) return;
  return { 0x1000007: 'darwin-x64', 0x100000c: 'darwin-arm64' }[read(4)];
}

function binaryPlatforms(bytes) {
  if (bytes.length < 32) return [];
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic === '7f454c46') {
    if (bytes.length < 64 || bytes[4] !== 2 || bytes[5] !== 1 || ![0, 3].includes(bytes[7])
      || ![2, 3].includes(bytes.readUInt16LE(16))) return [];
    const platform = { 62: 'linux-x64', 183: 'linux-arm64' }[bytes.readUInt16LE(18)];
    return platform ? [platform] : [];
  }
  const thin = machoPlatform(bytes);
  if (thin) return [thin];
  if (['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) {
    const little = ['bebafeca', 'bfbafeca'].includes(magic);
    const wide = ['cafebabf', 'bfbafeca'].includes(magic);
    const read = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const readWide = offset => Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset));
    const count = read(4), width = wide ? 32 : 20, end = 8 + count * width;
    if (!count || count > 32 || end > bytes.length) return [];
    const platforms = [];
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * width;
      const offset = wide ? readWide(entry + 8) : read(entry + 8);
      const size = wide ? readWide(entry + 16) : read(entry + 12);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 32
        || offset < end || offset + size > bytes.length) return [];
      const platform = machoPlatform(bytes.subarray(offset, offset + size));
      if (platform && platform === { 0x1000007: 'darwin-x64', 0x100000c: 'darwin-arm64' }[read(entry)]) {
        platforms.push(platform);
      }
    }
    return [...new Set(platforms)];
  }
  if (bytes.length >= 64 && bytes.subarray(0, 2).toString() === 'MZ') {
    const offset = bytes.readUInt32LE(60);
    if (offset < 64 || offset + 24 > bytes.length || bytes.subarray(offset, offset + 4).toString() !== 'PE\0\0'
      || !(bytes.readUInt16LE(offset + 22) & 2) || (bytes.readUInt16LE(offset + 22) & 0x2000)) return [];
    const platform = { 0x8664: 'win32-x64', 0xaa64: 'win32-arm64' }[bytes.readUInt16LE(offset + 4)];
    return platform ? [platform] : [];
  }
  return [];
}

function nativeBinary(bytes, platform) {
  return binaryPlatforms(bytes).includes(platform);
}

module.exports = { binaryPlatforms, nativeBinary };
