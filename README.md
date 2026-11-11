# DragonWork/install-action

Currently supports only prebuilt CLI tools from crates.io.

```yaml
steps:
  - uses: DragonWork/install-action@f56fb8f73b2c83f7711eebd7d3e58cc50aef2b51 # v1.2.1
  - uses: DragonWork/install-action/tools/git-cliff@7b03d4b6428472552f85b3df46fa8c175b8337fa # git-cliff/v2.14.2
  - run: git-cliff --version
```

[Search tools](https://dragonwork.github.io/install-action/)

Automatic discovery requires at least 10,000 total downloads. To add a CLI
regardless of download count, run the **Update crates** workflow with its name:

```sh
gh workflow run update-crates.yml --repo DragonWork/install-action --ref main -f crates=upki-cli
```

To publish only a specific version tag without changing the catalog branch, use
**Backfill crate version** instead:

```sh
gh workflow run backfill-version.yml --repo DragonWork/install-action --ref main -f crate=upki-cli -f version=1.0.0
```

Both manual workflows still require a non-yanked stable CLI release with
supported prebuilt binaries and verify archive and executable checksums.

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: daily
```

[Apache-2.0](LICENSE)
