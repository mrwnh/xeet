# CI: what runs, what it needs, and how a golden earns its place

This file is the implementation: Vercel CI (`turbo.json` `"tags": ["ci"]` +
`tools/ship/vercel-build.mjs`), the GitHub Actions workflows in
`.github/workflows/` (`release.yml`, `upstream-watch.yml`, `sync.yml`, and
`behavior-canary.yml`), the store they read, and the rule that decides whether
a snapshot is allowed to exist.

Pull requests never trigger CI or deployment builds: PRs are treated
functionally like issues so untrusted fork code never runs on runners. Every
push to `main` runs the full verification graph in Vercel CI, `release.yml`
builds self-contained native binaries on `v*` tags behind the protected
`release` environment and publishes via npm OIDC Trusted Publishing (zero
`NPM_TOKEN` secrets), and the site is deployed from the same tree at
[xeet-rs.vercel.app](https://xeet-rs.vercel.app).
`XEET_VENDOR_URL` is optional: the assets the build embeds (fonts,
`icons.json`, `tokens.json`, the default avatar) are committed under
`assets/vendor/`, so every job runs without a store configured. The store only
adds the captured pages and upstream snapshots, and the steps that need them say
why they skipped instead of failing.

## The pipelines

| Pipeline | When | Does | Time |
|---|---|---|---|
| Vercel CI (`turbo.json`) | push to `main` | `ci:gates` (contract, `#![forbid(unsafe_code)]`, golden stamps, release-gate tests, `actionlint`), `ci:rust-test` on 8 vCPU Ubuntu (fmt, clippy, workspace tests, stored Chrome layout & raster parity), `ci:wasm` + `ci:pkg-test` | ~1–2 minutes |
| `release.yml` | `v*` tag on `main` | ancestry & version verification, a green `Vercel CI` status on the tagged commit (waits up to 25 minutes), 6-platform self-contained Rust binaries, WASM build, 6-way cross-OS + WASM PNG determinism check, GitHub Artifact Attestations, draft GitHub Release, npm OIDC Trusted Publishing in two phases (below), install-from-npm check, GitHub Release published | ~15 minutes when npm's scan is quick |
| `upstream-watch.yml` (pipeline 2) | every 6h (`17 */6 * * *`) | logged-out probe of live x.com stylesheet & SSR invariants; opens deduplicated alarm issue or dispatches `sync.yml` | seconds |
| `sync.yml` (pipeline 3) | from watch, or by hand | snapshot to the private store, regenerate tokens, fingerprint, gates, then **either** a signed token-port PR **or** a repair-brief issue | 10–20 minutes |

Pipeline 3 is a skeleton with real seams: the oracle re-capture step runs the
replica harness (`tools/oracle/replica*.mjs`) and the behavior canary. The two
outcomes at the end are implemented; the policy decisions that are still manual
are called out in `sync.yml`.

### A release is all or nothing

npm scans an upload before it serves it, so `npm publish` returning success
does not mean the version can be installed. The scan usually takes minutes; it
held `@xeet/cli-linux-x64` for about a day on each of 0.1.0, 0.1.1 and 0.1.2. `@xeet/cli`
pins each platform package by exact version, and the workflow used to publish
it straight after them, so 0.1.1 and 0.1.2 were live with no Linux x64 binary
to install.

`release.yml` now publishes in two phases, with
[`tools/ship/npm-release.mjs`](../tools/ship/npm-release.mjs) as the gate
between them:

1. **`stage`** attests the tarballs, creates the GitHub Release as a draft, and
   publishes the six `@xeet/cli-<platform>` packages. Nothing installs those
   directly.
2. **`promote`** waits (up to 30 minutes) until the registry serves all six
   with the bytes built in that run. Only then does it publish `@xeet/core` and
   `@xeet/cli`, wait for both to be `latest`, install the release from npm on
   Linux x64 and render with it, and publish the GitHub Release.

If npm holds a package past the wait, `promote` fails and nothing user-facing
has been published: `latest` still resolves to the previous complete release,
and the GitHub Release is still a draft. Re-run the failed job once npm serves
the package (it sends an email when a publish is delayed). Every step skips
what is already done, and the staged tarballs are kept for 14 days.

`@xeet/core` and `@xeet/cli` are two uploads, each scanned by npm, so they
become installable minutes apart rather than at one instant.

### Why the PR pipeline is hermetic

No network at test time except the vendor restore at setup. Chrome is not
installed: the layout gate compares xeet against **stored** Chrome geometry, and
the raster gate compares against **stored** oracle images. Chrome only runs
where goldens are produced (pipeline 3 and the monthly bump), which is also the
only place that may change them.

## The store

The runtime assets the build embeds — Chirp, the fallback fonts, the icon
sprite, the design tokens, the default avatar — are committed under
`assets/vendor/` (`.gitignore` whitelists exactly those paths), so a fresh
checkout builds without any configuration. `assets/upstream.lock.json` records
the app version and a SHA-256 per file.

What is *not* committed is the capture set: the corpus pages, the upstream
snapshot (`assets/vendor/upstream/…`) and the recordings the oracles replay.
Those can be restored from a private, content-addressed store, and the steps
that need them are the ones that skip when it is absent.

```
<store>/<prefix>/index.json          { appVersion, fetchedAt, files: [{path, sha256, bytes}] }
<store>/<prefix>/fonts/manifest.json
<store>/<prefix>/fonts/Chirp-Regular.latin.ttf
<store>/<prefix>/icons.json
<store>/<prefix>/upstream/<appVersion>/…        raw captures, for auditors
```

Content-addressed means the path is the hash for immutable blobs:

```
<store>/blobs/sha256/<hex>           one file, forever
<store>/<appVersion>/index.json      which hashes that snapshot used
```

Any prefix works; the scripts only append paths. An S3 bucket, a Vercel Blob
store, or an internal artifact server are all fine. Two tokens, deliberately
separate:

| Secret | Used by | Rights |
|---|---|---|
| `XEET_VENDOR_URL` | `sync.yml`, `behavior-canary.yml` | read |
| `XEET_VENDOR_TOKEN` | `sync.yml`, `behavior-canary.yml` | read |
| `XEET_VENDOR_PUT_URL` | `sync.yml` only | write |
| `XEET_VENDOR_PUT_TOKEN` | `sync.yml` only | write |

A pull request never sees the write token, so a fork cannot poison the snapshot
that every later build trusts. `fetch-vendor.mjs` verifies every file against
both the store's index and the lockfile, and refuses a snapshot whose app
version differs from the lock.

Optional, for the behavior canary (pipeline 4): `XEET_TEST_ACCOUNT_*`
credentials, used only by `behavior-canary.yml`.

### What the store adds, and what runs without it

`xeet-core`'s `build.rs` embeds the vendored fonts, icons, design tokens and
default avatar from `assets/vendor/`, all of which are committed, so the Rust and
WASM jobs build on a plain checkout. The WebAssembly build sets
`XEET_FONT_PACKS=core`, so it embeds only Chirp and Arial; the six lazy packs are
built from the same vendor directory by `tools/ship/build-font-packs.mjs`.

The `vendor` job passes an `available` output — a job-level `if` cannot read
`secrets` — when `assets/vendor/fonts/manifest.json` is present (it is committed)
or when `XEET_VENDOR_URL` + `XEET_VENDOR_TOKEN` are set. With no store,
`fetch-vendor.mjs` exits 0 and restores nothing, and the steps that need the
capture set (the end-to-end run, the frame gate, the paint oracle) skip with the
reason in the job summary. With one, those run too.

| Job | Needs the store | What it proves |
|---|---|---|
| `contract` | no | model ↔ JSON Schema ↔ limits ↔ MCP tools agree; no golden without an oracle stamp; cores forbid `unsafe` |
| `lint` | no | every workflow parses (actionlint), every `.mjs`/`.js` parses (`node --check`) |
| `text` | no | the twitter-text conformance suite and the text engine's unit tests |
| `audit` | no | `cargo audit` over `Cargo.lock` |
| `vendor` | — | decides the four jobs below, and which capture-set steps can run |
| `rust` | only for the corpus steps | `cargo fmt --all --check`, clippy, the whole workspace's tests, the rules matrix, the rules canary, layout parity, the raster oracle |
| `wasm` | no | the ABI tests, the wasm build, the Node package tests |
| `determinism` → `determinism-compare` | no | identical bytes across Linux x64, Linux arm64, macOS, and native ↔ wasm |
| `bench` | no | the `bench-budgets.json` budgets and the binary-size budget |

All of them therefore run on a plain checkout; only the corpus-dependent steps
inside `rust` wait for the store. A green run without it means "everything that
does not need X's captures is green", and the `vendor` job's summary says which
steps skipped. `node tools/ship/fetch-vendor.mjs` still refuses a snapshot whose
app version differs from `assets/upstream.lock.json`.

The `sync.yml` and `behavior-canary.yml` pipelines need their own secrets on top
of that (write tokens and a test account respectively); they are scheduled and
manual, and are not part of a push run.

Locally, nothing is needed: `node tools/sync-upstream.mjs` fetches into
`assets/vendor/`, which is git-ignored.

### What a stamp covers (and what it does not)

A stamp records the hash of the **oracle that produced that golden**: the entry
script plus every module it reaches through a relative import, plus
`tools/package.json` and `tools/pnpm-lock.yaml` (every golden's Chrome comes from
there). `node tools/ship/golden-stamp.mjs --explain <script>` prints the exact
list:

```
$ node tools/ship/golden-stamp.mjs --explain tools/oracle/text-parity.mjs
  tools/oracle/browser.mjs
  tools/oracle/samples.mjs
  tools/oracle/text-parity.mjs
  tools/package.json
  tools/pnpm-lock.yaml
```

It used to hash *every* script under `tools/oracle/` into one blob, so editing
`cards-parity.mjs` invalidated the text and e2e stamps although neither golden is
produced by it (that is what failed `contract` on run 42916409620). A stamp that
covers files which cannot affect the golden is noise, and noise is what teaches
people to re-stamp without looking. The closure is derived from the imports, not
from a hand-kept list, so it cannot drift when an oracle grows a dependency.

Two consequences worth knowing:

- A change to a *shared* module (`browser.mjs`, `samples.mjs`) still invalidates
  every golden that imports it, because it really does change them.
- Changing a Rust crate does **not** invalidate a golden. That is deliberate: the
  goldens are what the oracle measured (Chrome's boxes, Chrome's pixels), and
  they are re-derived when the oracle or upstream moves, not when xeet changes.
  xeet disagreeing with a golden is a test failure, not a reason to re-stamp.

## Goldens: expected results only come from the oracle

Expected results only come from the oracle: a golden is what Chrome measured, and
nothing else may write one. The mechanism is `tools/ship/golden-stamp.mjs`.

Every golden under `tests/golden/` has a sidecar `<name>.stamp.json`:

```json
{
  "golden": "text.json",
  "sha256": "…",                       // of the golden bytes
  "cases": 1234,
  "generatedAt": "2026-11-09T21:00:00.000Z",
  "oracle": {
    "script": "tools/oracle/text-parity.mjs",
    "harnessSha256": "…",              // every tools/oracle/*.mjs plus the lock
    "chrome": "157.0.8103.39",
    "chromiumBuild": "1194",
    "playwright": "1.56.1"
  },
  "upstream": { "appVersion": "89824c04…", "stylesheetSha256": "1089…" },
  "host": "darwin-arm64"
}
```

`node tools/ship/golden-stamp.mjs --check` (a job in every PR) fails when:

- a golden has no stamp;
- the golden's bytes no longer match its stamp — the "update the snapshots"
  decay the principle exists to prevent;
- the stamp names a different upstream snapshot than the lockfile;
- the oracle harness changed since the stamp (the comparison itself moved);
- the stamp's Chrome is not `tools/ship/oracle-pin.json`'s Chrome.

The only way to make a stamp is `--write --golden <file> --oracle-log <log>`,
where the log is the oracle's own JSON summary (Chrome version, case count). The
stamper refuses a log older than the golden, a Chrome that is not the pin, or a
missing Chrome version. A stamp cannot be typed from a failing test.

The pin names **Playwright's bundled Chromium** (141.0.7390.37, build 1194),
because that is the browser `tools/oracle/browser.mjs` launches; the system
Chrome is recorded separately for manual checks. Bumping the pin is the monthly
oracle-bump job's decision, never a PR's.

### What is committed, and what is not

`tests/golden/` holds two goldens today: `text.json` (synthetic fuzz/space
strings and Chrome's line boxes, 1260 layouts) and `e2e.json` (counts, height
deltas, line counts, pixel ratios and a hash of the differing line for every post
the end-to-end run compared). Neither contains X's text or pixels — see
`tests/golden/README.md` for the table and the reason. Chrome screenshots and
corpus-derived text goldens stay in the private store.

`tools/ship/golden-capture.mjs` is the only producer: it runs the oracle, writes
the golden, writes the oracle's log, and stamps through `golden-stamp.mjs
--write`. `tools/ship/parity-check.mjs` then compares xeet against `text.json`
with no Chrome and no network, so the layout gate is no longer vacuous:
**1260 layouts, 0 line-break, 0 height and 0 position mismatches**, with line
widths inside 4/64 px (a line width is a sum of advances and Chrome quantizes it
again through `getClientRects`; positions stay at 1/64).

## Golden formats

| Kind | Files | Produced by | Checked by |
|---|---|---|---|
| Text/layout | `tests/golden/text.json` (`--save` output of `tools/oracle/text-parity.mjs`) | the text oracle | `tools/ship/parity-check.mjs` (no Chrome) |
| Raster | `tests/golden/raster/<case>.json` + `<case>.png` | the raster oracle | `crates/xeet-core/examples/ship_raster_check.rs`, ±2 per channel, ≤0.1% of pixels outside |

A raster case names its post inline (`"post": {...}`) or by file
(`"postFile": "../../fixtures/posts/text-simple.json"`), the `options`, and the
oracle image. The check reports the bounding box of the differences, which is
usually enough to name the component that moved.

## Benchmarks

`node tools/ship/bench.mjs` runs `crates/xeet-core/examples/ship_bench.rs`, then
measures what an example cannot: the cold start of the real binary (process
spawn to first PNG) and the size of the stripped release binary.

Budgets are in `bench-budgets.json`, the product promise those numbers encode.
Absolute budgets catch "slower than the product allows"; `bench-baseline.json`
(`--save-baseline`) catches "40% slower on this machine" even when the machine
is fast enough to hide it. Baselines are machine-tagged; a baseline from a
different machine is compared but not enforced.

## Determinism

`node tools/ship/determinism.mjs` renders every fixture at three viewport/theme/
density combinations twice natively and once through the WebAssembly module, and
compares SHA-256. CI runs it on Ubuntu x64, Ubuntu arm64 and macOS, uploads the
hashes, and a final job fails if any platform disagrees with another. That is the
determinism promise: identical bytes on Linux x64, Linux arm64, macOS and WASM.

### The wasm build needs a pinned wasm-bindgen

The module is wasm-bindgen output. The CLI version must equal the crate pin
exactly (`0.2.130`, in `crates/xeet-wasm/Cargo.toml` and in
`tools/ship/build-wasm.mjs`), or the generated glue and the Rust shims disagree
about the ABI in ways that look like silent corruption. CI installs it with
`taiki-e/install-action`; locally:

```sh
cargo install wasm-bindgen-cli --version 0.2.130 --locked
```

`build-wasm.mjs` refuses to run when the versions differ. It emits both flavours:
`--target nodejs` (CommonJS glue plus the `.wasm`, used by `@xeet/core/node` and
by the web demo's deployed resolver function, with a one-line `package.json` so
the `"type": "module"` package does not treat it as ESM) and `--target web` into
`wasm/web/` for browsers.

### Fat LTO miscompiles the rasterizer on wasm32

The workspace `[profile.release]` uses `lto = "fat"`, which is right for the
native binaries. Built for `wasm32-unknown-unknown` with fat LTO, the rasterizer
distorts large paths: media and card placeholders come out as skewed trapezoids
with missing rows, while glyphs, circles and icons stay correct. Thin LTO and no
LTO both render correctly and produce byte-identical output to each other.

`tools/ship/build-wasm.mjs` therefore builds the module with
`CARGO_PROFILE_RELEASE_LTO=thin` (override with `XEET_WASM_LTO`). The determinism
job is what caught this, and it is the check that keeps it caught: a
miscompiled raster shows up as a byte difference, because native and wasm were
built from the same source.

The same wasm32 build also needs a workaround on this machine: rust-lld's rpath
does not find its own `libLLVM.dylib`, so the script puts the toolchain's `lib/`
on `DYLD_LIBRARY_PATH`. On Linux, or a healthy toolchain, that line is inert.

### Where the determinism gate stands

Twelve cases (four fixtures × three viewport/theme/density combinations) run
natively and through the module, and all twelve currently produce byte-identical
PNGs and identical reports. Before the LTO fix, nine differed; before a later
rasterizer fix, one did (a 27×12 px glyph cluster in the action row, 143 px at
320/light/1). Both were caught here first, which is the point of the gate.

## Running the pipelines locally

```sh
node tools/sync-upstream.mjs                 # fetch the assets (network, low volume)
cargo test --workspace
cargo build --release --bin xeet && XEET_BIN=target/release/xeet node tools/ship/parity-check.mjs
cargo run --release --example ship_raster_check
node tools/ship/check-contract.mjs
node tools/ship/golden-stamp.mjs --check
node tools/ship/build-wasm.mjs && node --test packages/xeet/test/
node tools/ship/determinism.mjs
node tools/ship/bench.mjs
```
