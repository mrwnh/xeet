#!/usr/bin/env node
// The two publishing phases of a release, and the gate between them.
//
//   node tools/ship/npm-release.mjs publish <tarball.tgz>…
//   node tools/ship/npm-release.mjs wait [--timeout 1800] [--interval 30] [--require-latest] <tarball.tgz>…
//   node tools/ship/npm-release.mjs status <tarball.tgz>…
//
// `publish` uploads each tarball the registry does not already hold. `wait`
// exits 0 only once the registry serves every one of them with the bytes in the
// file (and, with `--require-latest`, as `latest`). `status` prints where each
// stands. See `npm-gate.mjs` for why, and `.github/workflows/release.yml` for
// the order they run in.
//
// This file runs `main` unconditionally. It has no "am I the entry point"
// check on purpose: one that guessed wrong would exit 0 without checking
// anything, and the release would go out through an open gate.

import { main } from "./npm-gate.mjs";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`npm-release: ${error.message}`);
  process.exitCode = 1;
}
