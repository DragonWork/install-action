# DragonWork/install-action

```yaml
steps:
  - uses: DragonWork/install-action@v1.0.0
  - uses: DragonWork/install-action/tools/git-cliff@git-cliff/v2.14.2
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
