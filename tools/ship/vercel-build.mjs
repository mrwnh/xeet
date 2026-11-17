#!/usr/bin/env node
// Vercel CI task runner + production WebAssembly/Next.js builder.
//
// Driven as discrete cached Turborepo tasks (`turbo.json`):
//   - `//#ci:gates`     (`ci`)                  contract, `#![forbid(unsafe_code)]`, golden stamps, workflow lint
//   - `//#ci:rust-test` (`ci`, 8 vCPU, Ubuntu)  rustfmt, clippy, workspace tests, Chrome layout & raster parity
//   - `//#ci:wasm`      (8 vCPU)                wasm32-unknown-unknown + SHA-256 verified wasm-bindgen + font packs
//   - `//#ci:pkg-test`  (`ci`)                  Node/WASM integration & lazy font-pack tests
//   - `//#ci:site`      (Vercel deployment)     stages `/wasm/<hash>` from `//#ci:wasm` and builds Next.js

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WASM_BINDGEN_VERSION = "0.2.130";
const WASM_BINDGEN_SHA256 = {
  "x86_64-unknown-linux-musl": "9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f",
};
const ACTIONLINT_VERSION = "1.7.12";
const ACTIONLINT_LINUX_X64_SHA256 = "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8";

const IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_CI);
const SKIP_TESTS = process.argv.includes("--skip-tests");

const CACHE_DIR = join(ROOT, "node_modules", ".cache", "xeet-ci");
const BIN_DIR = join(CACHE_DIR, "bin");
const RUSTUP_HOME = process.env.RUSTUP_HOME ?? (IS_VERCEL ? join(CACHE_DIR, "rustup") : join(homedir(), ".rustup"));
const CARGO_HOME = process.env.CARGO_HOME ?? (IS_VERCEL ? join(CACHE_DIR, "cargo") : join(homedir(), ".cargo"));

mkdirSync(BIN_DIR, { recursive: true });

function buildEnv() {
  const extraPaths = [BIN_DIR, join(CARGO_HOME, "bin")];
  try {
    const out = execFileSync("rustup", ["toolchain", "list", "-v"], {
      encoding: "utf8",
      env: { ...process.env, RUSTUP_HOME, CARGO_HOME, PATH: `${extraPaths.join(":")}:${process.env.PATH ?? ""}` },
    });
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+)\s+.*?(\/\S+)\s*$/);
      if (m && existsSync(join(m[2], "bin", "cargo"))) {
        extraPaths.unshift(join(m[2], "bin"));
        break;
      }
    }
  } catch {}
  return {
    ...process.env,
    RUSTUP_HOME,
    CARGO_HOME,
    PATH: `${extraPaths.join(":")}:${process.env.PATH ?? ""}`,
    CARGO_TERM_COLOR: "always",
    ...(IS_VERCEL
      ? {
          CARGO_TARGET_DIR: join(CACHE_DIR, "target"),
          XEET_WASM_TARGET_DIR: join(CACHE_DIR, "wasm-target"),
        }
      : {}),
  };
}

function hasCommand(cmd, args, env) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", env });
    return true;
  } catch {
    return false;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureRust(env, { needLintComponents = false } = {}) {
  const hasCargo = hasCommand("cargo", ["--version"], env);
  let hasWasmTarget = false;
  if (hasCargo) {
    try {
      const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8", env }).trim();
      hasWasmTarget = existsSync(join(sysroot, "lib", "rustlib", "wasm32-unknown-unknown", "lib"));
    } catch {}
  }

  if (!hasCargo) {
    const components = needLintComponents ? " --component rustfmt,clippy" : "";
    console.log("ci: installing minimal Rust stable + wasm32-unknown-unknown into build cache…");
    execSync(
      `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --target wasm32-unknown-unknown${components} --no-modify-path`,
      { stdio: "inherit", env },
    );
    return buildEnv();
  }

  const next = buildEnv();
  if (!hasWasmTarget) {
    console.log("ci: adding wasm32-unknown-unknown target…");
    execFileSync("rustup", ["target", "add", "wasm32-unknown-unknown"], { stdio: "inherit", env: next });
  }
  if (needLintComponents) {
    if (!hasCommand("cargo", ["fmt", "--version"], next)) {
      execFileSync("rustup", ["component", "add", "rustfmt"], { stdio: "inherit", env: next });
    }
    if (!hasCommand("cargo", ["clippy", "--version"], next)) {
      execFileSync("rustup", ["component", "add", "clippy"], { stdio: "inherit", env: next });
    }
  }
  return buildEnv();
}

function wasmBindgenTriple() {
  const os = platform();
  const cpu = arch();
  if (os === "linux" && cpu === "x64") return "x86_64-unknown-linux-musl";
  if (os === "linux" && cpu === "arm64") return "aarch64-unknown-linux-gnu";
  if (os === "darwin" && cpu === "arm64") return "aarch64-apple-darwin";
  if (os === "darwin" && cpu === "x64") return "x86_64-apple-darwin";
  throw new Error(`unsupported platform for prebuilt wasm-bindgen: ${os}/${cpu}`);
}

function ensureWasmBindgen(env) {
  for (const candidate of ["wasm-bindgen", join(BIN_DIR, "wasm-bindgen"), join(CARGO_HOME, "bin", "wasm-bindgen")]) {
    try {
      const v = execFileSync(candidate, ["--version"], { encoding: "utf8", env }).trim().split(" ").pop();
      if (v === WASM_BINDGEN_VERSION) {
        env.WASM_BINDGEN = candidate;
        return;
      }
    } catch {}
  }
  const triple = wasmBindgenTriple();
  const slug = `wasm-bindgen-${WASM_BINDGEN_VERSION}-${triple}`;
  const url = `https://github.com/rustwasm/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/${slug}.tar.gz`;
  console.log(`ci: fetching prebuilt ${slug}…`);
  const scratch = mkdtempSync(join(CACHE_DIR, "wbg."));
  const archive = join(scratch, `${slug}.tar.gz`);
  try {
    execFileSync("curl", ["-fsSL", url, "-o", archive], { stdio: "inherit", env });
    const expected = WASM_BINDGEN_SHA256[triple];
    if (expected) {
      const actual = sha256File(archive);
      if (actual !== expected) {
        throw new Error(`wasm-bindgen SHA-256 mismatch: expected ${expected}, got ${actual}`);
      }
    }
    execFileSync("tar", ["-xzf", archive, "-C", BIN_DIR, "--strip-components=1", `${slug}/wasm-bindgen`], {
      stdio: "inherit",
      env,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  env.WASM_BINDGEN = join(BIN_DIR, "wasm-bindgen");
}

function ensureActionlint(env) {
  const local = join(BIN_DIR, "actionlint");
  if (hasCommand("actionlint", ["-version"], env)) return "actionlint";
  if (existsSync(local)) return local;
  if (platform() !== "linux" || arch() !== "x64") return null;

  const url = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz`;
  const scratch = mkdtempSync(join(CACHE_DIR, "al."));
  const archive = join(scratch, "actionlint.tar.gz");
  try {
    execFileSync("curl", ["-fsSL", url, "-o", archive], { stdio: "inherit", env });
    const actual = sha256File(archive);
    if (actual !== ACTIONLINT_LINUX_X64_SHA256) {
      throw new Error(`actionlint SHA-256 mismatch: expected ${ACTIONLINT_LINUX_X64_SHA256}, got ${actual}`);
    }
    execFileSync("tar", ["-xzf", archive, "-C", BIN_DIR, "actionlint"], { stdio: "inherit", env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return local;
}

function step(label, fn) {
  const t0 = Date.now();
  console.log(`\n── ${label} ──`);
  fn();
  console.log(`✓ ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const STAGES = ["gates", "rust-test", "wasm", "pkg-test", "site"];
const onlyAt = process.argv.indexOf("--only");
const ONLY = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
if (ONLY && !STAGES.includes(ONLY) && ONLY !== "stage-wasm") {
  console.error(`unknown stage ${ONLY}; expected one of ${STAGES.join(", ")}, stage-wasm`);
  process.exit(2);
}
const runs = (stage) => (ONLY ? ONLY === stage : !(SKIP_TESTS && ["gates", "rust-test", "pkg-test"].includes(stage)));

let env = buildEnv();

function withToolchainLock(fn) {
  const lock = join(CACHE_DIR, "toolchain.lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - statSync(lock).mtimeMs > 15 * 60_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 15 * 60_000) throw new Error("timed out waiting for the toolchain lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (runs("rust-test") || runs("wasm")) {
  env = withToolchainLock(() => {
    const next = ensureRust(env, { needLintComponents: runs("rust-test") });
    if (runs("wasm")) ensureWasmBindgen(next);
    return next;
  });
}

if (runs("gates")) {
  step("Contract, unsafe, golden-stamp & workflow gates", () => {
    for (const required of ["tests/golden/text.json", "tests/golden/e2e.json", "assets/vendor/fonts/manifest.json"]) {
      if (!existsSync(join(ROOT, required))) {
        throw new Error(`missing required repository input: ${required}`);
      }
    }
    execFileSync("node", ["tools/ship/check-contract.mjs"], { cwd: ROOT, stdio: "inherit", env });
    execFileSync("node", ["tools/ship/check-unsafe.mjs"], { cwd: ROOT, stdio: "inherit", env });
    execFileSync("node", ["tools/ship/golden-stamp.mjs", "--check"], { cwd: ROOT, stdio: "inherit", env });
    // The gate `release.yml` publishes through; a release is the only other place it runs.
    execFileSync("node", ["--test", "tools/ship/npm-gate.test.mjs"], { cwd: ROOT, stdio: "inherit", env });
    const actionlint = ensureActionlint(env);
    if (actionlint) {
      execFileSync(actionlint, ["-color"], { cwd: ROOT, stdio: "inherit", env });
    }
  });
}

if (runs("rust-test")) {
  step("Rust fmt, clippy, workspace tests, layout & raster parity", () => {
    execFileSync("cargo", ["fmt", "--all", "--", "--check"], { cwd: ROOT, stdio: "inherit", env });
    execFileSync(
      "cargo",
      [
        "clippy",
        "--profile",
        "fast",
        "--workspace",
        "--all-targets",
        "--",
        "-D",
        "warnings",
        "-A",
        "clippy::too_many_arguments",
        "-A",
        "clippy::field_reassign_with_default",
        "-A",
        "clippy::neg_cmp_op_on_partial_ord",
        "-A",
        "clippy::self_named_constructors",
        "-A",
        "clippy::manual_noop_waker",
        "-A",
        "clippy::while_let_loop",
        "-A",
        "clippy::unnecessary_get_then_check",
      ],
      { cwd: ROOT, stdio: "inherit", env },
    );
    execFileSync("cargo", ["test", "--profile", "fast", "--workspace"], {
      cwd: ROOT,
      stdio: "inherit",
      env,
    });
    execFileSync("cargo", ["build", "--profile", "fast", "--bin", "xeet"], {
      cwd: ROOT,
      stdio: "inherit",
      env,
    });
    const targetRoot = env.CARGO_TARGET_DIR ?? join(ROOT, "target");
    const xeetBin = join(targetRoot, "fast", platform() === "win32" ? "xeet.exe" : "xeet");
    execFileSync("node", ["tools/ship/parity-check.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...env, XEET_BIN: xeetBin },
    });
    execFileSync("cargo", ["run", "--profile", "fast", "--example", "ship_raster_check"], {
      cwd: ROOT,
      stdio: "inherit",
      env,
    });
  });
}

const nodeWasm = join(ROOT, "packages", "xeet", "wasm", "xeet_wasm_bg.wasm");
const webWasm = join(ROOT, "packages", "xeet", "wasm", "web", "xeet_wasm_bg.wasm");
const wasmMissing = !existsSync(nodeWasm) || !existsSync(webWasm);
if (ONLY === "wasm" || (!ONLY && (!SKIP_TESTS || wasmMissing))) {
  step("Build Node + browser WebAssembly modules", () => {
    execFileSync("node", ["tools/ship/build-wasm.mjs"], { cwd: ROOT, stdio: "inherit", env });
  });
}

if (runs("pkg-test")) {
  step("WASM package tests", () => {
    execFileSync(
      "node",
      [
        "--test",
        "packages/xeet/test/xeet.test.js",
        "packages/xeet/test/fonts.test.js",
        "packages/xeet/test/resolve-host.test.js",
      ],
      { cwd: ROOT, stdio: "inherit", env: { ...env, XEET_REQUIRE_WASM: "1" } },
    );
  });
}

if (!runs("site") && ONLY !== "stage-wasm") process.exit(0);
if (wasmMissing && !existsSync(nodeWasm)) {
  console.error("site: the WebAssembly module is missing; run the wasm stage first");
  process.exit(1);
}

step("Stage /wasm/<hash> bundle for Next.js App Router", () => {
  const pubWasmRoot = join(ROOT, "public", "wasm");
  rmSync(pubWasmRoot, { recursive: true, force: true });

  const files = ["xeet_wasm.js", "xeet_wasm_bg.wasm"];
  const fontsDir = join(ROOT, "packages", "xeet", "wasm", "fonts");
  const fontFiles = readdirSync(fontsDir).sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(readFileSync(join(ROOT, "packages", "xeet", "wasm", "web", f)));
  for (const f of fontFiles) hash.update(readFileSync(join(fontsDir, f)));
  const wasmDir = `/wasm/${hash.digest("hex").slice(0, 16)}`;

  const dest = join(ROOT, "public", wasmDir);
  mkdirSync(join(dest, "fonts"), { recursive: true });
  for (const f of files) cpSync(join(ROOT, "packages", "xeet", "wasm", "web", f), join(dest, f));
  for (const f of fontFiles) cpSync(join(fontsDir, f), join(dest, "fonts", f));

  const wasmBytes = statSync(join(dest, "xeet_wasm_bg.wasm")).size;
  mkdirSync(join(ROOT, "app", "_generated"), { recursive: true });
  writeFileSync(
    join(ROOT, "app", "_generated", "wasm-manifest.js"),
    `// Auto-generated by tools/ship/vercel-build.mjs\nexport const WASM_DIR = ${JSON.stringify(wasmDir)};\nexport const WASM_BYTES = ${wasmBytes};\n`,
  );

  const fontBytes = fontFiles.reduce((n, f) => n + statSync(join(fontsDir, f)).size, 0);
  console.log(`staged ${wasmDir}/ (wasm ${(wasmBytes / 1e6).toFixed(2)} MB, lazy fonts ${(fontBytes / 1e6).toFixed(2)} MB)`);
});

if (ONLY === "stage-wasm") process.exit(0);

step("Build Next.js App Router site", () => {
  const nextBin = join(ROOT, "node_modules", ".bin", "next");
  execFileSync(nextBin, ["build"], { cwd: ROOT, stdio: "inherit", env });
});
