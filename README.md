# PocketAppsTCG Version Manifests

Central manifests for PocketXTCG applications and their shared data source,
[PKMNDB](https://github.com/ImLogueybear/PKMNDB).

This repository is the single public source for:

1. **Version checks** — every app polls its own manifest here.
2. **Licensing** — every app reads its advisory license document.
3. **Provider policy** — the shared data, pricing and AI choices.

No secrets, API keys, private release artifacts or customer data belong in this
repository. The files here are public and safe to cache.

## The download is the manifest's job

`url` **must be a direct, anonymously downloadable artifact** (an APK), not a
release page. Every app repository in this family is private, so
`github.com/<owner>/<repo>/releases/tag/<tag>` returns 404 to anyone without
credentials and `api.github.com/repos/.../releases/assets/...` requires a token
that cannot be shipped inside an app. When `url` pointed at a release page, the
manifest validated, the apps fetched it, and the Update button led to a dead
page on every install — which is exactly the outage this contract prevents.

- `url` — the artifact. Fetched by the client, opened in the system browser,
  handed to the Android package installer.
- `sha256`, `size` — required for apps; the artifact's digest and byte length.
- `releaseUrl` — optional human-readable release/changelog page. May be private.
  Clients only use it for the "Changelog" link.

Artifacts are hosted on the public R2 bucket under `apps/<app id>/<tag>/` and
served from `https://pub-54a82c9e988c459da62f95d0bd9c78d9.r2.dev`. Publishing is
`scripts/publish-release.mjs`; it uploads, verifies an anonymous download, and
writes both `updates.json` and `versions/<tag>.json`. `scripts/validate.mjs`
re-checks the download on every push, every PR, and daily.

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
3. When an update is available, open `url` — the artifact download — in the
   system browser so Android hands it to the package installer. `releaseUrl` is
   only ever a changelog link. On native, never use `window.open`: the
   Capacitor WebView has no multi-window support and drops it silently.
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
| `build` | Monotonically increasing build number (`versionCode`) |
| `tag` | Release tag, for example `v0.8.0` |
| `notes` | Release notes shown to the user |
| `url` | **Direct download of the artifact.** Never a release page |
| `sha256` | SHA-256 of the artifact at `url` (required for apps) |
| `size` | Byte length of the artifact at `url` (required for apps) |
| `releaseUrl` | Optional release/changelog page; may be private |
| `publishedAt` | ISO 8601 publication timestamp |

New manifests may also carry `schemaVersion` and `appId`; clients must accept the
legacy flat form. Clients must reject a manifest whose `url` is missing, is not
`https`, or is a GitHub release page — that degrades to "couldn't check for
updates" instead of offering a download that cannot work.

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

Do not hand-write `updates.json`: a manifest with a dead `url` is worse than no
manifest, and the validator will fail the build for it.

```bash
# From the app repo, after the APK is built:
node ../PocketAppsTCG/scripts/publish-release.mjs \
  --app pocketvaulttcg \
  --apk artifacts/PocketVaultTCG-0.33.0-debug.apk \
  --release-url https://github.com/ImLogueybear/PocketVaultTCG/releases/tag/v0.33.0 \
  --notes-file release-notes.md

git -C ../PocketAppsTCG add -A && git -C ../PocketAppsTCG commit -m "Publish ..."
git -C ../PocketAppsTCG push
```

The script derives `version`/`build` from the APK name and
`android/app/build.gradle`, uploads the artifact to `apps/<app id>/<tag>/`,
proves it downloads anonymously with a matching sha256, then writes
`updates.json` and the immutable `versions/<tag>.json`. `--dry-run` prints the
manifest without uploading or writing.

Each app repo wraps this: `PocketVendorTCG/scripts/publish-apk.sh` and
`PocketVaultTCG/scripts/publish-update-manifest.mjs` call it and push, so the
GitHub Release and the update feed can never disagree.

PKMNDB data is published from its own repository. If PKMNDB moves its branch,
paths, or image host, update `pkmndb/manifest.json` here.

## Validating

```bash
node scripts/validate.mjs            # everything, including live downloads
node scripts/validate.mjs --offline  # shape + local consistency only
node scripts/validate.mjs --no-download
```

The validator has no dependencies. Besides the catalog, manifests, license
documents and policy, it fetches each advertised `url` **anonymously**, requires
an APK (`PK` magic, not HTML), and compares the byte length and SHA-256 against
the manifest — the check that would have caught the release-page regression.
