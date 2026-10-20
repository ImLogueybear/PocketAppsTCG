# Licensing policy (pending)

Licensing for the PocketApps family is **not finalized**. This document is the
shared policy reference linked from every `licensing/<app>.json` document and
from the applications' settings screens.

## Current state

- Status: `pending`
- Enforcement: `advisory`
- License: `All rights reserved`

Applications must show this status to the user. They must **not** disable core
features, block scanning, hide pricing or refuse to launch while enforcement is
`advisory`.

## When licensing is finalized

The following fields are reserved so applications can implement enforcement
without another schema change:

| Field | Meaning |
| --- | --- |
| `status` | `active`, `pending`, `expired`, `revoked` or `trial` |
| `enforcement` | `advisory`, `required` or `blocking` |
| `license` | Human-readable license name |
| `holder` | License holder / organization |
| `entitlements` | Feature keys the installation is licensed for |
| `flags` | Free-form feature flags |
| `expiresAt` | ISO timestamp when the license expires |
| `graceUntil` | ISO timestamp for a grace period after expiry |

An app may only block a licensed feature when `enforcement` is `"required"` or
`"blocking"` **and** the remote document was successfully fetched and validated.
A network failure must be treated as “unknown”, never as “unlicensed”.

## Updating licensing

1. Edit `licensing/<app>.json` and, if the policy itself changes, this file.
2. Update `index.json` if license paths or the shared summary change.
3. Run `node scripts/validate.mjs`.
4. Commit and push. Applications pick the change up on their next check.

Do not put secrets, customer identifiers or private contract terms in this
public repository.
