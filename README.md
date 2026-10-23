# DragonWork Install

Install CLI crates with separate SHA pins for the installer and each tool.
Dependabot updates only the tools your workflow uses.

```yaml
steps:
  - uses: DragonWork/install-action@ENGINE_SHA # v1.0.0
  - uses: DragonWork/install-action/tools/git-cliff@CRATE_SHA # git-cliff/v1.0.0
  - run: git-cliff --version
```

Prebuilt binaries are preferred. Archives and executables are checked against
pinned SHA-256 checksums. When no matching binary exists, the action builds the
pinned crates.io source using its committed `Cargo.lock`. Source builds require
Rust and the crate's native build dependencies on the runner.

Add this to `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: daily
```

Any CLI crate with a stable crates.io release can be registered through the
**Update crates** workflow's `crates` input. Registered crates are checked at
04:23 and 16:23 UTC. Each changed crate gets a signed commit and an immutable
`<crate>/v<manifest-version>` tag. Manifest versions are separate from upstream
crate versions. See [releases](https://github.com/DragonWork/install-action/releases)
for pins and crate versions.

The installer and workflows live on `main`; tool manifests live on `crates`.
Installer releases use `v<version>` tags and are independent of crate updates.

Optional tool inputs:

| Input | Purpose |
| --- | --- |
| `source` | Set to `true` to build from source. |
| `features` | Cargo features; builds from source. |
| `no-default-features` | Set to `true` to disable default Cargo features. |
| `bins` | Binary names separated by spaces or commas; builds from source. |

Each tool adds its binaries to `PATH` and exposes `version` and `path` outputs.

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE).
