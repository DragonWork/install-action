# DragonWork/install-action

```yaml
steps:
  - uses: DragonWork/install-action@84c72c0d1860436d8bd9daa7952f7d17df1219c0 # v1.0.0
  - uses: DragonWork/install-action/tools/git-cliff@7b03d4b6428472552f85b3df46fa8c175b8337fa # git-cliff/v2.14.2
  - run: git-cliff --version
```

[Available tools](https://github.com/DragonWork/install-action/tree/crates.io/tools)

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
