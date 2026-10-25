# DragonWork/install-action

Currently supports only prebuilt CLI tools from crates.io.

```yaml
steps:
  - uses: DragonWork/install-action@f56fb8f73b2c83f7711eebd7d3e58cc50aef2b51 # v1.2.1
  - uses: DragonWork/install-action/tools/git-cliff@7b03d4b6428472552f85b3df46fa8c175b8337fa # git-cliff/v2.14.2
  - run: git-cliff --version
```

[Search tools](https://dragonwork.github.io/install-action/)

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
