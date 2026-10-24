export const platforms = Object.freeze({
  'linux-x64': 'Linux x64', 'linux-arm64': 'Linux ARM64',
  'darwin-x64': 'macOS x64', 'darwin-arm64': 'macOS ARM64',
  'win32-x64': 'Windows x64', 'win32-arm64': 'Windows ARM64',
});

export function filterTools(tools, query, platform, order = 'popular') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tools.filter(tool => (!platform || tool.platforms.includes(platform))
    && words.every(word => `${tool.name} ${tool.binaries.join(' ')}`.toLowerCase().includes(word)))
    .sort((a, b) => (order === 'name' ? 0 : (b.popularity || 0) - (a.popularity || 0))
      || a.name.localeCompare(b.name, 'en'));
}

export function installationSteps(engine, tool) {
  const sha = /^[a-f0-9]{40}$/, version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!sha.test(engine.sha) || !sha.test(tool.sha) || !version.test(engine.version)
    || !version.test(tool.version) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(tool.name)) {
    throw new Error('Invalid action reference.');
  }
  return `steps:\n  - uses: DragonWork/install-action@${engine.sha} # v${engine.version}\n`
    + `  - uses: DragonWork/install-action/tools/${tool.name}@${tool.sha} # ${tool.name}/v${tool.version}\n`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function start() {
  const response = await fetch('./tools.json');
  if (!response.ok) throw new Error('Catalog unavailable.');
  const catalog = await response.json();
  if (catalog.schema !== 1 || !Array.isArray(catalog.tools)) throw new Error('Invalid catalog.');
  const query = document.querySelector('#query'), platform = document.querySelector('#platform');
  const order = document.querySelector('#order');
  const list = document.querySelector('#tools'), count = document.querySelector('#count');
  const previous = document.querySelector('#previous'), next = document.querySelector('#next');
  const dialog = document.querySelector('#usage'), snippet = document.querySelector('#snippet');
  const copy = document.querySelector('#copy'), copyStatus = document.querySelector('#copy-status');
  const byName = new Map(catalog.tools.map(tool => [tool.name, tool]));
  const params = new URLSearchParams(location.search);
  query.value = params.get('q') || '';
  platform.value = Object.hasOwn(platforms, params.get('platform')) ? params.get('platform') : '';
  order.value = params.get('sort') === 'name' ? 'name' : 'popular';
  const pageSize = 50;
  let page = 0, matches = [];

  function row(tool) {
    const item = element('li', 'tool');
    const identity = element('div');
    const name = element('a', 'tool-name', tool.name);
    name.href = `https://crates.io/crates/${encodeURIComponent(tool.name)}`;
    const metadata = element('div', 'metadata');
    metadata.append(element('code', 'version', `v${tool.version}`));
    if (tool.yanked) metadata.append(element('span', 'yanked', 'Yanked'));
    identity.append(name, metadata);
    if (Number.isSafeInteger(tool.recentDownloads)) {
      const downloads = element('p', 'commands', `${tool.recentDownloads.toLocaleString()} downloads in 90 days`);
      identity.append(downloads);
    }
    if (tool.binaries.length !== 1 || tool.binaries[0] !== tool.name) {
      identity.append(element('p', 'commands', tool.binaries.join(', ')));
    }
    const supported = element('div', 'platforms');
    for (const [key, label] of Object.entries(platforms)) {
      if (tool.platforms.includes(key)) supported.append(element('span', 'platform', label));
    }
    const use = element('button', '', 'Use');
    use.type = 'button';
    use.dataset.tool = tool.name;
    use.setAttribute('aria-label', `Use ${tool.name}`);
    item.append(identity, supported, use);
    return item;
  }

  function render() {
    matches = filterTools(catalog.tools, query.value, platform.value, order.value);
    const pages = Math.ceil(matches.length / pageSize);
    page = Math.max(0, Math.min(page, pages - 1));
    count.textContent = `${matches.length.toLocaleString()} of ${catalog.tools.length.toLocaleString()} tools`;
    document.querySelector('#empty').hidden = matches.length > 0;
    document.querySelector('#pagination').hidden = pages <= 1;
    document.querySelector('#page-number').textContent = `Page ${page + 1} of ${pages}`;
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    list.replaceChildren(...matches.slice(page * pageSize, (page + 1) * pageSize).map(row));
    const url = new URL(location.href);
    for (const [key, value] of [['q', query.value], ['platform', platform.value], ['sort', order.value === 'name' ? 'name' : '']]) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
  }

  query.addEventListener('input', () => { page = 0; render(); });
  platform.addEventListener('change', () => { page = 0; render(); });
  order.addEventListener('change', () => { page = 0; render(); });
  previous.addEventListener('click', () => { page--; render(); });
  next.addEventListener('click', () => { page++; render(); });
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-tool]');
    if (!button) return;
    const tool = byName.get(button.dataset.tool);
    snippet.textContent = installationSteps(catalog.engine, tool);
    document.querySelector('#usage-title').textContent = `Use ${tool.name}`;
    document.querySelector('#yank-warning').hidden = !tool.yanked;
    copyStatus.textContent = '';
    dialog.showModal();
    copy.focus();
  });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(snippet.textContent);
      copyStatus.textContent = 'Copied.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(snippet);
      selection.removeAllRanges();
      selection.addRange(range);
      copyStatus.textContent = 'Select and copy the steps above.';
    }
  });
  const updated = new Date(catalog.updatedAt);
  if (catalog.updatedAt && !Number.isNaN(updated.getTime())) {
    document.querySelector('#updated').textContent = `Registry snapshot: ${updated.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    })}`;
  }
  render();
}

if (typeof document !== 'undefined') {
  start().catch(() => { document.querySelector('#count').textContent = 'Could not load the catalog. Please reload the page.'; });
}
