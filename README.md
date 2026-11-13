# DragonWork/install-action

Currently supports only prebuilt CLI tools from crates.io.

```yaml
steps:
  - uses: DragonWork/install-action@016fbb7b16bf02f327f8e0a9ed25398118eee43d # v1.2.2
  - uses: DragonWork/install-action/tools/git-cliff@7b03d4b6428472552f85b3df46fa8c175b8337fa # git-cliff/v2.14.2
  - run: git-cliff --version
```

[Search tools](https://dragonwork.github.io/install-action/)

[Apache-2.0](LICENSE)
