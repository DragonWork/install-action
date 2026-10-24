'use strict';

const { assert, NAME, VERSION } = require('./common.cjs');

function warning(message) {
  console.log('::warning::' + message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
}

async function checkYanked(manifest, { fetcher = fetch, report = warning } = {}) {
  const { name, version } = manifest;
  assert(NAME.test(name) && VERSION.test(version), 'Invalid crate identity for yank check.');
  try {
    const response = await fetcher(`https://crates.io/api/v1/crates/${name}/${version}`, {
      redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'DragonWork/install-action (https://github.com/DragonWork/install-action)' },
    });
    assert(response.ok, `crates.io returned HTTP ${response.status}`);
    const data = (await response.json()).version;
    assert(data?.crate === name && data.num === version && typeof data.yanked === 'boolean', 'Unexpected crates.io version metadata');
    if (data.yanked) report(`${name} ${version} is yanked on crates.io. Continuing with the checksum-pinned prebuilt binary; update the tool pin when possible.`);
    return data.yanked;
  } catch (error) {
    report(`Could not check yank status for ${name} ${version}: ${error.message}. Continuing with the checksum-pinned prebuilt binary.`);
    return null;
  }
}

module.exports = { checkYanked };
