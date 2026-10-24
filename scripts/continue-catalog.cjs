'use strict';

const { api } = require('./github.cjs');
const { assert, failure } = require('../lib/common.cjs');

async function main() {
  assert(process.env.GITHUB_REPOSITORY === 'DragonWork/install-action'
    && process.env.GITHUB_REF === 'refs/heads/main', 'Continue only from the main repository.');
  const base = '/repos/DragonWork/install-action';
  const file = await api(`${base}/contents/catalog-progress.json?ref=crates.io`, { optional: true });
  if (!file) return;
  const progress = JSON.parse(Buffer.from(file.content, 'base64'));
  if (progress.remaining === 0) return;
  if (progress.runnable === 0 && Date.parse(progress.nextRetryAt) > Date.now()) return;
  for (const status of ['queued', 'in_progress']) {
    const runs = await api(`${base}/actions/workflows/update-crates.yml/runs?branch=main&status=${status}&per_page=1`);
    if (runs.workflow_runs.some(run => String(run.id) !== process.env.GITHUB_RUN_ID)) return;
  }
  const limits = await api('/rate_limit');
  if (limits.resources.core.remaining < 200 || limits.resources.graphql.remaining < 300) return;
  await api(`${base}/actions/workflows/update-crates.yml/dispatches`, { method: 'POST', body: { ref: 'main' } });
  console.log('Continuing the unpublished catalog.');
}

if (require.main === module) main().catch(failure);
