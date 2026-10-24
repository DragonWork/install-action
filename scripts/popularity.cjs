'use strict';

function popularity(entry = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  // Recent use dominates; logarithms and a release cap limit size and publishing-frequency bias.
  return 0.6 * Math.log1p(count(entry.recentDownloads))
    + 0.3 * Math.log1p(count(entry.downloads))
    + 0.1 * Math.log1p(Math.min(count(entry.recentVersions), 12));
}

module.exports = { popularity };
