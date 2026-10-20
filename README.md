# PocketAppsTCG Version Manifests

Central manifests for PocketXTCG applications and their shared data source,
[PKMNDB](https://github.com/ImLogueybear/PKMNDB).

## Layout

```text
index.json                        # App catalog and shared-data entry point
pocketvaulttcg/
  updates.json                    # Current PocketVaultTCG release
  versions/                       # Immutable per-release snapshots
pocketvendortcg/
  updates.json                    # Current PocketVendorTCG release
  versions/
    v0.8.0.json
pkmndb/
  manifest.json                   # Current PKMNDB locations and image host
```

## Client flow

1. Fetch `index.json` to discover the manifest path for an app.
2. Fetch the app's `updates.json` and compare `build` (preferred) or `version`
   with the installed build.
3. When an update is available, open `url` for the release page or download
   the artifact it links to.
4. Fetch `pkmndb/manifest.json` for the shared data locations. The `manifest`
   field points at PKMNDB's live manifest, which contains the current data
   schema version, generation timestamp, counts, and relative file names.
   Resolve those file names against `distBaseUrl`.

All paths in `index.json` are relative to the repository root, so the same
files work on GitHub Pages, raw GitHub, or a custom domain.

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
an app's first release is published.

## Publishing a release

1. Update the app's `updates.json` with the new version and build number.
2. Copy the same contents to `versions/<tag>.json` as an immutable snapshot.
3. Update `updatedAt` in `index.json` if the app catalog changes.
4. Commit and push; clients pick up the new manifest on their next check.

PKMNDB data is published from its own repository. If PKMNDB moves its branch,
paths, or image host, update `pkmndb/manifest.json` here.
