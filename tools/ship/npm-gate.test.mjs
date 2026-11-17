// The gate between the two publishing phases of a release: `publish` uploads,
// `wait` holds until the registry serves what was uploaded. These run against a
// registry made of plain objects; nothing here touches the network or npm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { REGISTRY, integrityOf, publishAll, readManifest, registryState, waitAll } from "./npm-gate.mjs";

/** A tar entry: one 512-byte ustar header and the content padded to 512. */
function entry(name, content, type = "0") {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/** An npm-shaped tarball; the manifest is deliberately not the first entry. */
function tarball(name, version, extra = "") {
  return gzipSync(
    Buffer.concat([
      entry("PaxHeader/package", "27 path=package/bin/xeet\n", "x"),
      entry("package/bin/xeet", "binary" + extra),
      entry("package/package.json", JSON.stringify({ name, version })),
      Buffer.alloc(1024),
    ]),
  );
}

function pkg(name, version, extra = "") {
  const bytes = tarball(name, version, extra);
  return { path: `dist/${name.split("/")[1]}-${version}.tgz`, name, version, integrity: integrityOf(bytes) };
}

/**
 * A registry: `served` maps `name@version` to the integrity it serves, `latest`
 * maps a name to its dist-tag. Anything else is absent, as a version still
 * being scanned is.
 */
function registry({ served = {}, latest = {}, calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    if (init.method === "HEAD") return { ok: true, status: 200 };
    const name = decodeURIComponent(url.slice(REGISTRY.length + 1));
    const versions = {};
    for (const [id, integrity] of Object.entries(served)) {
      const at = id.lastIndexOf("@");
      if (id.slice(0, at) !== name) continue;
      const version = id.slice(at + 1);
      versions[version] = { dist: { integrity, tarball: `${REGISTRY}/${name}/-/${version}.tgz` } };
    }
    if (Object.keys(versions).length === 0 && !(name in latest)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: latest[name] ?? null }, versions }) };
  };
}

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
const quiet = { log: () => {} };

test("the name and version come from the manifest inside the tarball", () => {
  assert.deepEqual(readManifest(tarball("@xeet/cli-linux-x64", "0.1.2")), {
    name: "@xeet/cli-linux-x64",
    version: "0.1.2",
  });
  assert.throws(() => readManifest(gzipSync(Buffer.concat([entry("package/README.md", "x"), Buffer.alloc(1024)]))));
});

test("integrity is the registry's sha512 form", () => {
  assert.equal(
    integrityOf(Buffer.from("abc")),
    "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
  );
});

test("a version is available only when the registry serves our bytes", async () => {
  const mine = pkg("@xeet/cli-linux-x64", "0.1.2");
  assert.equal((await registryState(mine, registry())).state, "absent");
  assert.equal(
    (await registryState(mine, registry({ served: { "@xeet/cli-linux-x64@0.1.0": "sha512-old" } }))).state,
    "absent",
  );
  assert.equal(
    (await registryState(mine, registry({ served: { "@xeet/cli-linux-x64@0.1.2": mine.integrity } }))).state,
    "available",
  );
  const other = await registryState(mine, registry({ served: { "@xeet/cli-linux-x64@0.1.2": "sha512-other" } }));
  assert.equal(other.state, "mismatch");
  const down = await registryState(mine, async () => {
    throw new Error("ECONNRESET");
  });
  assert.equal(down.state, "unknown");
});

test("publish uploads what is missing, skips what is served, and can be run again", async () => {
  const served = pkg("@xeet/cli-darwin-arm64", "0.1.2");
  const fresh = pkg("@xeet/cli-linux-arm64", "0.1.2");
  const scanning = pkg("@xeet/cli-linux-x64", "0.1.2");
  const uploads = [];
  const run = (path) => {
    uploads.push(path);
    return path === scanning.path
      ? { status: 1, output: "npm error 403 You cannot publish over the previously published versions: 0.1.2." }
      : { status: 0, output: "+ ok" };
  };
  const outcomes = await publishAll([served, fresh, scanning], {
    fetchImpl: registry({ served: { "@xeet/cli-darwin-arm64@0.1.2": served.integrity } }),
    run,
    ...quiet,
  });
  assert.deepEqual(
    outcomes.map((o) => o.outcome),
    ["available", "published", "submitted"],
  );
  assert.deepEqual(uploads, [fresh.path, scanning.path], "the served version is never uploaded again");
});

test("publish stops on a real npm failure and on different bytes under the same version", async () => {
  const mine = pkg("@xeet/core", "0.1.2");
  await assert.rejects(
    publishAll([mine], { fetchImpl: registry(), run: () => ({ status: 1, output: "npm error code E401" }), ...quiet }),
    /npm publish failed for @xeet\/core@0\.1\.2/,
  );
  let uploaded = false;
  await assert.rejects(
    publishAll([mine], {
      fetchImpl: registry({ served: { "@xeet/core@0.1.2": "sha512-someone-elses" } }),
      run: () => {
        uploaded = true;
        return { status: 0, output: "" };
      },
      ...quiet,
    }),
    /different contents/,
  );
  assert.equal(uploaded, false, "nothing is uploaded over a version that differs");
});

test("the gate stays shut while npm is still scanning one platform binary", async () => {
  // The 0.1.1 and 0.1.2 releases: every upload accepted, five platform
  // packages served within minutes, linux-x64 held for a day.
  const packages = PLATFORMS.map((platform) => pkg(`@xeet/cli-${platform}`, "0.1.2"));
  const served = Object.fromEntries(
    packages.filter((p) => p.name !== "@xeet/cli-linux-x64").map((p) => [`${p.name}@${p.version}`, p.integrity]),
  );
  let clock = 0;
  const result = await waitAll(packages, {
    fetchImpl: registry({ served }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeoutMs: 90_000,
    intervalMs: 30_000,
    ...quiet,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(
    result.pending.map((p) => `${p.name}:${p.state}`),
    ["@xeet/cli-linux-x64:absent"],
  );
  assert.equal(clock, 90_000, "it waited the whole window before giving up");
});

test("the gate opens once every package is served, and rides out a registry blip", async () => {
  const packages = PLATFORMS.map((platform) => pkg(`@xeet/cli-${platform}`, "0.1.3"));
  const served = {};
  let polls = 0;
  let clock = 0;
  const inner = registry({ served });
  const result = await waitAll(packages, {
    fetchImpl: async (url, init) => {
      if (polls === 1 && !init?.method) throw new Error("ETIMEDOUT");
      return inner(url, init);
    },
    sleep: async (ms) => {
      clock += ms;
      polls += 1;
      // The scans finish while we wait.
      if (polls === 2) for (const p of packages) served[`${p.name}@${p.version}`] = p.integrity;
    },
    now: () => clock,
    timeoutMs: 600_000,
    intervalMs: 30_000,
    ...quiet,
  });
  assert.equal(result.ready, true);
  assert.equal(clock, 60_000);
});

test("with --require-latest a served version that latest does not point at is not ready", async () => {
  const cli = pkg("@xeet/cli", "0.1.3");
  const served = { "@xeet/cli@0.1.3": cli.integrity };
  let clock = 0;
  const options = {
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    timeoutMs: 60_000,
    intervalMs: 30_000,
    ...quiet,
  };
  const stale = await waitAll([cli], {
    ...options,
    requireLatest: true,
    fetchImpl: registry({ served, latest: { "@xeet/cli": "0.1.2" } }),
  });
  assert.equal(stale.ready, false);
  assert.equal(stale.pending[0].state, "untagged");
  const moved = await waitAll([cli], {
    ...options,
    requireLatest: true,
    fetchImpl: registry({ served, latest: { "@xeet/cli": "0.1.3" } }),
  });
  assert.equal(moved.ready, true);
});

test("the command line always runs: it cannot exit 0 without doing anything", () => {
  // An "am I the entry point" check once compared a symlinked path with the
  // real one, decided it was being imported, and exited 0 with the gate open.
  const here = dirname(fileURLToPath(import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "npm-release-"));
  try {
    symlinkSync(here, join(scratch, "ship"));
    for (const entry of [join(here, "npm-release.mjs"), join(scratch, "ship", "npm-release.mjs")]) {
      const none = spawnSync(process.execPath, [entry], { encoding: "utf8" });
      assert.equal(none.status, 1, entry);
      assert.match(none.stderr, /usage: npm-release\.mjs/);
      const missing = spawnSync(process.execPath, [entry, "wait", join(scratch, "nope.tgz")], { encoding: "utf8" });
      assert.equal(missing.status, 1, entry);
      assert.match(missing.stderr, /ENOENT/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("waiting fails at once when the registry serves different bytes", async () => {
  const cli = pkg("@xeet/cli", "0.1.3");
  await assert.rejects(
    waitAll([cli], {
      fetchImpl: registry({ served: { "@xeet/cli@0.1.3": "sha512-not-ours" } }),
      timeoutMs: 0,
      ...quiet,
    }),
    /different contents/,
  );
});
