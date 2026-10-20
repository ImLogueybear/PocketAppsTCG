# PocketAppsTCG Version Manifests

Central manifests for PocketXTCG applications and their shared data source,
[PKMNDB](https://github.com/ImLogueybear/PKMNDB).

This repository is the single public source for:

1. **Version checks** — every app polls its own manifest here.
2. **Licensing** — every app reads its advisory license document.
3. **Provider policy** — the shared data, pricing and AI choices.

No secrets, API keys, private release artifacts or customer data belong in this
repository. The files here are public and safe to cache.

## Layout

```text
index.json                        # App catalog, license paths and policy entry point
policy.json                       # Shared data, pricing and AI provider policy
pocketvaulttcg/
  updates.json                    # Current PocketVaultTCG release
  versions/                       # Immutable per-release snapshots
pocketvendortcg/
  updates.json                    # Current PocketVendorTCG release
  versions/
pkmndb/
  manifest.json                   # Current PKMNDB data locations and image host
  updates.json                    # Current PKMNDB pipeline version
licensing/                        # Per-app license status (advisory for now)
schemas/                          # JSON Schemas for the public documents
scripts/validate.mjs              # Validates every document in this repository
```

## Client flow

1. Fetch `index.json` to discover the manifest path for an app.
2. Fetch the app's `updates.json` and compare `build` (preferred) or `version`
   with the installed build.
3. When an update is available, open `url` for the release page or download the
   artifact it links to.
4. Fetch `pkmndb/manifest.json` for the shared data locations. The `manifest`
   field points at PKMNDB's live manifest, which contains the current data
   schema version, generation timestamp, counts, and relative file names.
   Resolve those file names against `distBaseUrl`.
5. Fetch the app's license document (advisory while licensing is pending).
6. Fetch `policy.json` for the shared data/pricing/AI provider choices.

All paths in `index.json` are relative to the repository root, so the same files
work on GitHub Pages, raw GitHub, or a custom domain.

## App manifest fields

| Field | Description |
| --- | --- |
| `version` | Release version, for example `0.8.0` |
| `build` | Monotonically increasing build number |
| `tag` | Release tag, for example `v0.8.0` |
| `notes` | Release notes shown to the user |
| `url` | Release page or direct download URL |
| `publishedAt` | ISO 8601 publication timestamp |

`version`, `tag`, `url`, and `publishedAt` are `null` and `build` is `0` until
an app's first release is published. New manifests may also carry
`schemaVersion` and `appId`; clients must accept the legacy flat form.

## Licensing (pending)

Licensing is **not finalized**. Every `licensing/<app>.json` reports
`status: "pending"` and `enforcement: "advisory"`. Applications must show the
status but must not block core features while enforcement is advisory. See
`licensing/README.md` for the reserved fields and future enforcement rules.

## Provider policy

`policy.json` fixes the shared provider choices:

- **Metadata, artwork, set logos/symbols:** PKMNDB.
- **Raw card pricing:** TCGplayer (primary) with PriceCharting as a reference.
- **Graded card comps:** eBay sold/active listings and SoldComps, with
  PriceCharting as a reference.
- **AI scan identification:** DeepSeek vision, fallback only (never the primary
  on-device matcher).

Applications may keep local overrides for keys and offline fallbacks, but new
integrations should follow this policy.

## Publishing a release

1. Update the app's `updates.json` with the new version and build number.
2. Copy the same contents to `versions/<tag>.json` as an immutable snapshot.
3. Update `updatedAt` in `index.json` if the app catalog changes.
4. Commit and push; clients pick up the new manifest on their next check.

PKMNDB data is published from its own repository. If PKMNDB moves its branch,
paths, or image host, update `pkmndb/manifest.json` here.

## Validating

```bash
node scripts/validate.mjs
```

The validator has no dependencies. It checks the catalog, app manifests,
license documents, PKMNDB manifest, and policy document.
