'use strict';

const { assert } = require('../lib/common.cjs');

async function api(endpoint, { method = 'GET', body, optional = false } = {}) {
  assert(endpoint.startsWith('/'), 'Invalid GitHub API endpoint.');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DragonWork-install-action',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`GitHub API ${method} ${endpoint}: HTTP ${response.status} ${detail.message || ''}`);
  }
  return response.status === 204 ? null : response.json();
}

async function signedCommit(repository, branch, head, message, files, deletions = []) {
  assert(branch === 'crates.io', 'Unsupported publication branch.');
  assert(/^(feat|fix|chore|docs|test|ci|refactor|perf|build)(\([a-zA-Z0-9_-]+\))?!?: .+/.test(message), 'Use a Conventional Commit message.');
  const result = await api('/graphql', { method: 'POST', body: {
    query: `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid signature { isValid } } }
    }`,
    variables: { input: {
      branch: { repositoryNameWithOwner: repository, branchName: branch },
      expectedHeadOid: head, message: { headline: message },
      fileChanges: { additions: Object.entries(files).map(([file, content]) => ({
        path: file, contents: Buffer.from(content).toString('base64'),
      })), deletions: deletions.map(file => ({ path: file })) },
    } },
  } });
  assert(!result.errors, `Could not create signed commit: ${result.errors?.map(e => e.message).join('; ')}`);
  const commit = result.data.createCommitOnBranch.commit;
  assert(commit.signature?.isValid, `Commit ${commit.oid} is not verified; refusing to tag it.`);
  return commit.oid;
}

async function release(repository, tag, commit, body, latest = false) {
  const base = `/repos/${repository}`;
  const ref = await api(`${base}/git/ref/tags/${tag}`, { optional: true });
  if (ref) {
    let object = ref.object;
    while (object.type === 'tag') object = (await api(`${base}/git/tags/${object.sha}`)).object;
    assert(object.sha === commit, `Tag ${tag} already points to a different commit.`);
  } else await api(`${base}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: commit } });
  const existing = await api(`${base}/releases/tags/${tag}`, { optional: true });
  assert(!existing?.draft, `Release ${tag} is still a draft.`);
  if (!existing) await api(`${base}/releases`, { method: 'POST', body: {
    tag_name: tag, target_commitish: commit, name: tag, body,
    draft: false, prerelease: false, make_latest: latest ? 'true' : 'false',
  } });
}

module.exports = { api, signedCommit, release };
