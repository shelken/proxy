#!/usr/bin/env bun
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const action = args.shift() ?? "all";
const options = {};
while (args.length) {
  const flag = args.shift();
  if (!["--out", "--source", "--build-dir", "--suite", "--vm"].includes(flag) || !args.length) throw new Error("unknown or incomplete argument: " + flag);
  options[flag.slice(2)] = args.shift();
}
if (!["all", "launch", "doctor", "drive", "cleanup"].includes(action)) throw new Error("action must be all, launch, doctor, drive, or cleanup");
const source = resolve(options.source ?? join(import.meta.dir, "../../../.."));
const out = resolve(options.out ?? join(source, ".sandbox-artifacts/verification", new Date().toISOString().replaceAll(":", "-")));
const manifestPath = join(out, "manifest.json");
const suites = options.suite ? options.suite.split(",") : ["offline", "server", "observability", "remote", "mac"];
if (suites.some(s => !["offline", "server", "observability", "remote", "mac"].includes(s))) throw new Error("unknown suite");
const vm = options.vm ?? "proxy-test";

function invoke(command, label, settings = {}) {
  const p = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", ...settings });
  if (label) {
    mkdirSync(out, { recursive: true });
    const text = "$ " + command.join(" ") + "\nexit=" + p.exitCode + "\n" + p.stdout.toString() + p.stderr.toString();
    writeFile(label + ".log", text);
  }
  if (p.exitCode !== 0) throw new Error(command[0] + " failed, exit=" + p.exitCode + "\n" + p.stderr.toString());
  return p.stdout.toString().trim();
}
function writeFile(name, text) { writeFileSync(join(out, name), text); }
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function fingerprint(root) {
  const paths = ["Cargo.toml", "Cargo.lock", "scripts/sbtools-rs/Cargo.toml", "config/sing-box/template.json"];
  const walk = rel => { for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = join(rel, entry.name);
    if (entry.isDirectory()) walk(path); else if (entry.isFile()) paths.push(path);
  } };
  walk("scripts/sbtools-rs/src");
  return Object.fromEntries(paths.sort().map(path => [path, sha(join(root, path))]));
}

let manifest;
if (action === "launch" || action === "all") {
  mkdirSync(out, { recursive: true });
  if (await Bun.file(manifestPath).exists()) throw new Error("output already has a run manifest; choose a fresh --out");
  const runId = randomUUID();
  const build = options["build-dir"] ? resolve(options["build-dir"]) : mkdtempSync(join(tmpdir(), "sbtools-verify-build-"));
  const snapshot = join(out, "source");
  const guest = "/work/sbtools-verify/" + runId;
  manifest = { runId, commit: invoke(["git", "-C", source, "rev-parse", "HEAD"]), source, vm, guest, build, ownedBuild: !options["build-dir"], inputs: fingerprint(source), suites: [], phase: "building", binaries: {}, evidence: out };
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  for (const path of ["Cargo.toml", "Cargo.lock", "scripts/sbtools-rs", "config/sing-box/template.json"]) {
    mkdirSync(join(snapshot, path, ".."), { recursive: true });
    cpSync(join(source, path), join(snapshot, path), { recursive: true });
  }
  cpSync(import.meta.dir, join(out, "kit"), { recursive: true });
  try {
    invoke(["docker", "image", "inspect", "rust:1-bookworm"], "docker-image");
    invoke(["limactl", "shell", "--workdir", "/work", vm, "sudo", "-n", "unshare", "--net", "--mount", "--pid", "--fork", "true"], "namespace-doctor");
    invoke(["cargo", "build", "--release", "--locked", "--offline", "-p", "sbtools", "--target-dir", join(build, "mac-target")], "build-mac", { cwd: snapshot });
    invoke(["docker", "run", "--rm", "--pull", "never", "--network", "none", "-v", snapshot + ":/source:ro", "-v", join(homedir(), ".cargo/registry") + ":/usr/local/cargo/registry:ro", "-v", build + ":/artifacts", "-w", "/source", "-e", "CARGO_TARGET_DIR=/artifacts/linux-target", "rust:1-bookworm", "cargo", "build", "--release", "--locked", "--offline", "-p", "sbtools"], "build-linux");
    for (const platform of ["mac", "linux"]) {
      const path = join(out, "sbtools-" + platform);
      cpSync(join(build, platform + "-target/release/sbtools"), path);
      manifest.binaries[platform] = { path, sha256: sha(path) };
    }
    invoke(["limactl", "shell", "--workdir", "/work", vm, "mkdir", "-p", guest]);
    invoke(["limactl", "copy", "--backend=scp", join(out, "sbtools-linux"), vm + ":" + guest + "/sbtools"]);
    for (const [local, target] of [[join(out, "kit"), "kit"], [snapshot, "source"]]) invoke(["limactl", "copy", "--backend=scp", "-r", local, vm + ":" + guest + "/" + target]);
    invoke(["limactl", "shell", "--workdir", guest, vm, "chmod", "+x", guest + "/sbtools"]);
    manifest.phase = "ready";
  } catch (error) {
    manifest.phase = "launch-failed"; manifest.error = String(error); throw error;
  } finally { await Bun.write(manifestPath, JSON.stringify(manifest, null, 2)); }
} else {
  manifest = await Bun.file(manifestPath).json();
  if (!/^[0-9a-f-]{36}$/.test(manifest.runId) || manifest.guest !== "/work/sbtools-verify/" + manifest.runId) throw new Error("invalid run ownership marker");
}

if (action === "doctor" || action === "all") {
  for (const platform of ["mac", "linux"]) if (sha(manifest.binaries[platform].path) !== manifest.binaries[platform].sha256) throw new Error(platform + " binary hash mismatch");
  if (JSON.stringify(fingerprint(manifest.source)) !== JSON.stringify(manifest.inputs)) throw new Error("source changed since launch");
  const guestHash = invoke(["limactl", "shell", "--workdir", manifest.guest, manifest.vm, "sha256sum", manifest.guest + "/sbtools"], "doctor-linux-hash").split(/\s+/)[0];
  if (guestHash !== manifest.binaries.linux.sha256) throw new Error("guest binary hash mismatch");
  const macVersion = invoke([manifest.binaries.mac.path, "version"], "doctor-mac");
  const linuxVersion = invoke(["limactl", "shell", "--workdir", manifest.guest, manifest.vm, manifest.guest + "/sbtools", "version"], "doctor-linux");
  if (macVersion !== linuxVersion) throw new Error("platform versions disagree");
  manifest.version = macVersion;
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ commit: manifest.commit, version: macVersion, binaries: manifest.binaries, guest: manifest.guest }, null, 2));
}

if (action === "drive" || action === "all") {
  let failed = false;
  try {
    for (const suite of suites) {
      if (suite === "mac") {
        const dir = join(out, "mac");
        mkdirSync(dir, { recursive: true });
        const p = Bun.spawnSync(["bun", "--no-env-file", "test", join(out, "kit/mac.test.js"), "--timeout", "30000"], { cwd: dir, env: { ...process.env, SBTOOLS_BIN: manifest.binaries.mac.path }, stdout: "pipe", stderr: "pipe" });
        writeFile("suite-mac.log", p.stdout.toString() + p.stderr.toString());
        manifest.suites.push({ name: suite, exit: p.exitCode, isolation: "macOS, synthetic HOME and owned HTTP server; original clipboard restored" });
        failed ||= p.exitCode !== 0;
        console.log("mac: " + (p.exitCode === 0 ? "PASS" : "FAIL") + " (exit " + p.exitCode + ")");
        continue;
      }
      const guest = manifest.guest;
      const dir = guest + "/" + suite;
      invoke(["limactl", "shell", "--workdir", guest, manifest.vm, "mkdir", "-p", dir]);
      const flags = suite === "remote" ? ["--mount", "--pid", "--fork", "--mount-proc"] : ["--net", "--mount", "--pid", "--fork", "--mount-proc"];
      const command = ["limactl", "shell", "--workdir", dir, manifest.vm, "sudo", "-n", "unshare", ...flags, "python3", guest + "/kit/isolate.py", suite, guest, manifest.commit];
      const p = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
      await writeFile("suite-" + suite + ".log", p.stdout.toString() + p.stderr.toString());
      manifest.suites.push({ name: suite, exit: p.exitCode, isolation: suite === "remote" ? "VM public network, mount and PID namespaces" : "network, mount and PID namespaces, loopback only" });
      failed ||= p.exitCode !== 0;
      try { invoke(["limactl", "copy", "--backend=scp", "-r", manifest.vm + ":" + dir, join(out, suite)]); } catch (error) { failed = true; manifest.suites.at(-1).artifactError = String(error); }
      console.log(suite + ": " + (p.exitCode === 0 ? "PASS" : "FAIL") + " (exit " + p.exitCode + ")");
    }
    manifest.phase = failed ? "failed" : "passed";
    process.exitCode = failed ? 1 : 0;
  } finally {
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
    invoke(["limactl", "shell", "--workdir", "/work", manifest.vm, "sudo", "-n", "python3", "-c", "import shutil,sys; shutil.rmtree(sys.argv[1])", manifest.guest], "cleanup-guest");
    manifest.guestCleaned = true;
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

if (action === "cleanup" || action === "all") {
  if (!manifest.guestCleaned) {
    invoke(["limactl", "shell", "--workdir", "/work", manifest.vm, "sudo", "-n", "python3", "-c", "import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)", manifest.guest], "cleanup-guest");
    manifest.guestCleaned = true;
  }
  if (manifest.ownedBuild) { rmSync(manifest.build, { recursive: true, force: true }); manifest.buildCleaned = true; }
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
}
console.log("Evidence: " + out);
