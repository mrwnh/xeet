// Publishing to npm so that a release is all or nothing. The command line is
// `npm-release.mjs`, which does nothing but call `main` here; the logic lives in
// this module so the tests can import it without running it.
//
// npm scans a package after it accepts the upload and before it serves it. The
// scan usually takes minutes; it has held `@xeet/cli-linux-x64` for a day. While
// it runs the version does not exist for anyone installing, but `npm publish`
// has already returned success. `@xeet/cli` pins its platform packages by exact
// version, so publishing it on the strength of that success shipped 0.1.1 and
// 0.1.2 with no Linux x64 binary behind them.
//
// So the release workflow publishes in two phases and this script is the gate
// between them: `publish` uploads, `wait` holds until the registry serves each
// version with the bytes we built. The name and version come from the tarball
// itself, never from an argument, so the gate checks what was uploaded.
//
// `publish` can be run again at any point. A version the registry already serves
// is skipped; one it accepted but is still scanning is recognised by npm's
// refusal to take it twice; a version served with different bytes is an error.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export const REGISTRY = "https://registry.npmjs.org";

/** npm's refusal to accept a version it already holds, served or still scanning. */
const ALREADY_SUBMITTED = /EPUBLISHCONFLICT|cannot publish over|previously published/i;

/** `sha512-<base64>`, the form the registry reports as `dist.integrity`. */
export function integrityOf(bytes) {
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}

/** `name` and `version` from the `package/package.json` inside an npm tarball. */
export function readManifest(tgz) {
  const tar = gunzipSync(tgz);
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    const name = field(345, 155) ? field(345, 155) + "/" + field(0, 100) : field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if ((type === "0" || type === "") && name === "package/package.json") {
      const manifest = JSON.parse(tar.subarray(at + 512, at + 512 + size).toString("utf8"));
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error("package/package.json has no name or version");
      }
      return { name: manifest.name, version: manifest.version };
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("no package/package.json in the tarball");
}

/** What we are about to publish, or have published: read from the file. */
export function describe(path, read = readFileSync) {
  const bytes = read(path);
  return { path, ...readManifest(bytes), integrity: integrityOf(bytes) };
}

/**
 * Where a version stands on the registry, from the document installers read.
 *
 *   available  served, with our bytes
 *   absent     not served: never uploaded, or uploaded and still being scanned
 *   mismatch   served with different bytes
 *   unknown    the registry did not give a usable answer
 */
export async function registryState(pkg, fetchImpl = fetch) {
  const url = `${REGISTRY}/${pkg.name.replace("/", "%2f")}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json", "cache-control": "no-cache" },
    });
  } catch (error) {
    return { state: "unknown", detail: `registry unreachable (${error.message})` };
  }
  if (response.status === 404) return { state: "absent", detail: "the package is not on the registry" };
  if (!response.ok) return { state: "unknown", detail: `registry answered ${response.status}` };
  let packument;
  try {
    packument = await response.json();
  } catch {
    return { state: "unknown", detail: "registry answer was not JSON" };
  }
  const latest = packument["dist-tags"]?.latest ?? null;
  const published = packument.versions?.[pkg.version];
  if (!published) return { state: "absent", latest, detail: "not served yet" };
  if (published.dist?.integrity !== pkg.integrity) {
    return {
      state: "mismatch",
      latest,
      detail: `the registry serves ${published.dist?.integrity}, the tarball here is ${pkg.integrity}`,
    };
  }
  try {
    const tarball = await fetchImpl(published.dist.tarball, { method: "HEAD" });
    if (!tarball.ok) return { state: "absent", latest, detail: `listed, but its tarball answers ${tarball.status}` };
  } catch (error) {
    return { state: "unknown", latest, detail: `tarball unreachable (${error.message})` };
  }
  return { state: "available", latest };
}

function npmPublish(path) {
  const result = spawnSync("npm", ["publish", path, "--access", "public", "--registry", REGISTRY], {
    encoding: "utf8",
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Upload every tarball the registry does not already hold. Returns one outcome
 * per tarball: `available` (already served), `published` (uploaded now) or
 * `submitted` (uploaded earlier, npm has not made it available yet).
 */
export async function publishAll(packages, { fetchImpl = fetch, run = npmPublish, log = console.log } = {}) {
  const outcomes = [];
  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    const before = await registryState(pkg, fetchImpl);
    if (before.state === "mismatch") {
      throw new Error(`${id} is already on npm with different contents: ${before.detail}`);
    }
    if (before.state === "unknown") {
      throw new Error(`cannot tell whether ${id} is on npm: ${before.detail}`);
    }
    if (before.state === "available") {
      log(`${id}: already available, skipping`);
      outcomes.push({ ...pkg, outcome: "available" });
      continue;
    }
    log(`${id}: publishing ${pkg.path}`);
    const result = run(pkg.path);
    if (result.output) log(result.output.trimEnd());
    if (result.status === 0) {
      outcomes.push({ ...pkg, outcome: "published" });
    } else if (ALREADY_SUBMITTED.test(result.output)) {
      log(`${id}: npm already holds this version and has not made it available yet`);
      outcomes.push({ ...pkg, outcome: "submitted" });
    } else {
      throw new Error(`npm publish failed for ${id} (exit ${result.status})`);
    }
  }
  return outcomes;
}

/**
 * Poll until the registry serves every package, or the time runs out. With
 * `requireLatest`, a package also has to be what `latest` points at, which is
 * what a plain `npm install <name>` resolves.
 */
export async function waitAll(
  packages,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    timeoutMs = 30 * 60_000,
    intervalMs = 30_000,
    requireLatest = false,
    log = console.log,
  } = {},
) {
  const deadline = now() + timeoutMs;
  const last = new Map();
  for (;;) {
    const pending = [];
    for (const pkg of packages) {
      const id = `${pkg.name}@${pkg.version}`;
      const current = await registryState(pkg, fetchImpl);
      if (current.state === "mismatch") {
        throw new Error(`${id} is on npm with different contents: ${current.detail}`);
      }
      let state = current.state;
      let detail = current.detail ?? "";
      if (state === "available" && requireLatest && current.latest !== pkg.version) {
        state = "untagged";
        detail = `available, but latest is ${current.latest}`;
      }
      if (last.get(id) !== state) {
        log(`${id}: ${state}${detail ? ` (${detail})` : ""}`);
        last.set(id, state);
      }
      if (state !== "available") pending.push({ ...pkg, state, detail });
    }
    if (pending.length === 0) return { ready: true, pending };
    if (now() >= deadline) return { ready: false, pending };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

function annotate(title, lines) {
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=${title}::${lines.join("%0A")}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${lines.join("\n")}\n`);
  }
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const options = { timeout: 1800, interval: 30, requireLatest: false };
  const paths = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--timeout") options.timeout = Number(rest[++i]);
    else if (rest[i] === "--interval") options.interval = Number(rest[++i]);
    else if (rest[i] === "--require-latest") options.requireLatest = true;
    else if (rest[i].startsWith("--")) throw new Error(`unknown option ${rest[i]}`);
    else paths.push(rest[i]);
  }
  if (!["publish", "wait", "status"].includes(command) || paths.length === 0) {
    throw new Error("usage: npm-release.mjs <publish|wait|status> [options] <tarball.tgz>…");
  }
  if (!Number.isFinite(options.timeout) || !Number.isFinite(options.interval) || options.interval <= 0) {
    throw new Error("--timeout and --interval take a number of seconds");
  }
  const packages = paths.map((path) => describe(path));

  if (command === "publish") {
    await publishAll(packages);
    return 0;
  }
  if (command === "status") {
    for (const pkg of packages) {
      const current = await registryState(pkg);
      const tail = [current.latest != null ? `latest ${current.latest}` : "", current.detail ?? ""].filter(Boolean);
      console.log(`${pkg.name}@${pkg.version}: ${current.state}${tail.length ? ` (${tail.join("; ")})` : ""}`);
    }
    return 0;
  }
  const result = await waitAll(packages, {
    timeoutMs: options.timeout * 1000,
    intervalMs: options.interval * 1000,
    requireLatest: options.requireLatest,
  });
  if (result.ready) {
    console.log(`npm serves all ${packages.length} package${packages.length === 1 ? "" : "s"}`);
    return 0;
  }
  const id = (pkg) => `${pkg.name}@${pkg.version}`;
  const lines = result.pending.map((pkg) => `- ${id(pkg)}: ${pkg.state}${pkg.detail ? ` (${pkg.detail})` : ""}`);
  const untagged = result.pending.filter((pkg) => pkg.state === "untagged");
  if (untagged.length === result.pending.length) {
    const fix = untagged.map((pkg) => `npm dist-tag add ${id(pkg)} latest`).join(" && ");
    lines.push("", `npm serves these but did not move latest. Run: ${fix}, then re-run this job.`);
  } else {
    lines.push(
      "",
      "npm has not made these available yet. Nothing after this step has run.",
      "Re-run this job once npm serves them.",
    );
  }
  const total = `${packages.length} package${packages.length === 1 ? "" : "s"}`;
  annotate(`npm is not serving ${result.pending.length} of ${total} yet`, lines);
  for (const line of lines) console.error(line);
  return 1;
}
