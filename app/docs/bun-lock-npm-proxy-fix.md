# `bun install` hangs off-VPN — internal npm-proxy URLs baked into `bun.lock`

## Symptom

`bun install` in `app/` never completes. It prints `bun install v1.x.x` and then
either sits silent or repeats `[PackageManager] waiting for N tasks` forever,
regardless of `--network-concurrency`, `--no-cache`, or `--ignore-scripts`.

## Root cause

Every package entry in the committed `app/bun.lock` had its tarball `resolved`
URL baked to Databricks' internal npm proxy, e.g.:

```
"7zip-bin": ["7zip-bin@5.2.0", "https://npm-proxy.dev.databricks.com/7zip-bin/-/7zip-bin-5.2.0.tgz", ...]
```

That proxy is only reachable from inside the Databricks corporate
network/VPN. Confirmed via `curl -m 8 https://npm-proxy.dev.databricks.com/react`
→ connection timeout. Off-VPN, `bun install` doesn't fail fast on this — it just
hangs, which looks identical to a generic stuck install.

This is the same class of issue already called out in `scripts/build.sh` for
`app_template/package-lock.json` and the generated `uv.lock` (both get their
`npm-proxy`/`pypi-proxy` URLs rewritten to the public registry at build time)
— it just hadn't been applied to this top-level `bun.lock`.

### Diagnostics that ruled out other causes first

- Network to the **public** registry was fine: `curl https://registry.npmjs.org/react`
  → 200, fast, over both IPv4 and IPv6.
- Bun's own `fetch()` against the same registry URL worked fine — ruling out a
  TLS/fingerprint block on Bun's HTTP client in general. (A Cisco Umbrella root
  CA — a corporate TLS-inspection proxy — is installed on the affected machine
  and was the first suspect; exporting it and pointing Bun at it via `--cafile`
  made no difference. Red herring.)
- The hang was specific to `bun install`'s package-fetch step, and the global
  Bun cache stayed empty across every attempt — confirming zero packages were
  ever successfully resolved before the fix.

## Fix

Rewrite every `npm-proxy.{dev,cloud}.databricks.com` URL in `bun.lock` to the
public registry:

```bash
perl -i -pe 's{https://npm-proxy[.-][a-z0-9.-]*databricks\.com/}{https://registry.npmjs.org/}g' bun.lock
```

Then `bun install --ignore-scripts` (the `--ignore-scripts` flag also skips
`electron`'s postinstall binary download, which isn't needed for a plain
frontend/wheel rebuild).

## Open question

Should the rewritten `bun.lock` be committed outright (so this doesn't bite
the next off-VPN build), or should the rewrite instead become a build-time
step — mirroring how `scripts/build.sh` already handles
`app_template/package-lock.json` and `uv.lock` — so on-network builds/CI keep
using the faster internal proxy and only the shipped artifact gets the public
URLs? Not resolved as of this writing.
