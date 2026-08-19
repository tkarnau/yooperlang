#!/usr/bin/env node
// yoopkg - a tiny, deliberately throwaway package manager for yooperlang.
//
// What it does:
//   * Reads `yoop.json` in the current directory.
//   * Looks each dependency up in a local registry (tools/yoopkg/registry.json).
//   * Copies the package's declared `.yoop` files into `./yoop_packages/<name>/`.
//   * Writes a `yoop.lock.json` recording what got installed.
//
// What it explicitly does NOT do:
//   * No network. The "registry" is a JSON file mapping package names to
//     local source paths. Swap in a tarball server, git, or a content-addressed
//     blob store later - the install step would only change at the "fetch"
//     boundary.
//   * No semver. Versions are exact-match strings. "0.1.0" must equal "0.1.0".
//   * No build step. Yoop modules are source files; copying is enough.
//   * No publish flow. To "publish" a package today, add an entry to
//     tools/yoopkg/registry.json pointing at its directory.
//
// Why a yoop_packages/ directory rather than teaching the compiler about
// package names: yooperlang imports are file-path based (with `std/` as the
// one privileged prefix). Putting installed packages somewhere the existing
// resolver can find them keeps the compiler unchanged. A consumer imports
// `./yoop_packages/yooparse/json.yoop` just like any other relative path.
// There is no `pkg/` resolver prefix mirroring `std/`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = path.join(SCRIPT_DIR, "registry.json");
const PACKAGES_DIR = "yoop_packages";
const MANIFEST_NAME = "yoop.json";
const LOCK_NAME = "yoop.lock.json";

function usage() {
  process.stdout.write(
    [
      "yoopkg - tiny package manager for yooperlang",
      "",
      "usage:",
      "  yoopkg install              install dependencies declared in yoop.json",
      "  yoopkg list                 show installed packages (from yoop.lock.json)",
      "  yoopkg registry             show what the configured registry knows about",
      "",
      "environment:",
      "  YOOPKG_REGISTRY=<path>      override path to registry.json",
      "",
    ].join("\n"),
  );
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function loadRegistry() {
  const p = process.env.YOOPKG_REGISTRY ?? DEFAULT_REGISTRY;
  if (!fs.existsSync(p)) {
    fail(`registry not found at ${p}`);
  }
  const reg = readJson(p);
  // Resolve relative source paths against the registry file's own dir, so
  // entries can use paths like "../../examples/playground/yooparse".
  const regDir = path.dirname(path.resolve(p));
  for (const [name, versions] of Object.entries(reg.packages ?? {})) {
    for (const v of Object.values(versions)) {
      v.resolvedSource = path.resolve(regDir, v.source);
    }
  }
  return { path: p, data: reg };
}

function loadConsumerManifest() {
  const p = path.resolve(MANIFEST_NAME);
  if (!fs.existsSync(p)) {
    fail(`no ${MANIFEST_NAME} in current directory`);
  }
  return { path: p, data: readJson(p) };
}

function loadPackageManifest(srcDir, name) {
  const p = path.join(srcDir, MANIFEST_NAME);
  if (!fs.existsSync(p)) {
    fail(`package "${name}" at ${srcDir} has no ${MANIFEST_NAME}`);
  }
  const data = readJson(p);
  if (data.name !== name) {
    fail(`package at ${srcDir} declares name "${data.name}" but registry has it as "${name}"`);
  }
  return data;
}

function fail(msg) {
  process.stderr.write(`yoopkg: ${msg}\n`);
  process.exit(1);
}

// Walk dependencies in topological order (deps before dependents). Throws on
// cycles and on missing registry entries.
function resolveAll(consumerDeps, registry) {
  const resolved = new Map(); // name -> { version, source, manifest }
  const onStack = new Set();

  function visit(name, version) {
    if (resolved.has(name)) {
      const prev = resolved.get(name);
      if (prev.version !== version) {
        fail(`conflicting versions for "${name}": ${prev.version} vs ${version}`);
      }
      return;
    }
    if (onStack.has(name)) {
      fail(`dependency cycle involving "${name}"`);
    }
    onStack.add(name);

    const versions = registry.data.packages?.[name];
    if (!versions) {
      fail(`registry has no package "${name}"`);
    }
    const entry = versions[version];
    if (!entry) {
      const known = Object.keys(versions).join(", ");
      fail(`registry has no version "${version}" for "${name}" (known: ${known})`);
    }
    const manifest = loadPackageManifest(entry.resolvedSource, name);

    for (const [depName, depVersion] of Object.entries(manifest.dependencies ?? {})) {
      visit(depName, depVersion);
    }

    resolved.set(name, {
      version,
      source: entry.resolvedSource,
      manifest,
    });
    onStack.delete(name);
  }

  for (const [name, version] of Object.entries(consumerDeps ?? {})) {
    visit(name, version);
  }
  return resolved;
}

// Copy each `.yoop` file declared by `files` into yoop_packages/<name>/.
// We do NOT mirror the package's own dependencies on disk - the consumer's
// yoop_packages/ is flat, one dir per package, so the consumer always imports
// `./yoop_packages/foo/...` regardless of how foo internally references bar.
// (Foo's own internal cross-file imports stay relative within its own dir.)
function installOne(name, info, root) {
  const destDir = path.join(root, PACKAGES_DIR, name);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  const files = info.manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    fail(`package "${name}" must declare a non-empty "files" array in ${MANIFEST_NAME}`);
  }

  const copied = [];
  for (const rel of files) {
    if (rel.includes("..") || path.isAbsolute(rel)) {
      fail(`package "${name}" file "${rel}" must be a relative path under the package dir`);
    }
    const from = path.join(info.source, rel);
    const to = path.join(destDir, rel);
    if (!fs.existsSync(from)) {
      fail(`package "${name}" declares file "${rel}" but it is missing at ${from}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(rel);
  }

  // Stash a copy of the package's manifest alongside the files so a human
  // poking around yoop_packages/ can see what they got.
  writeJson(path.join(destDir, MANIFEST_NAME), info.manifest);
  return copied;
}

function cmdInstall() {
  const registry = loadRegistry();
  const consumer = loadConsumerManifest();
  const deps = consumer.data.dependencies ?? {};
  if (Object.keys(deps).length === 0) {
    process.stdout.write("no dependencies declared in yoop.json - nothing to install.\n");
    return;
  }

  const resolved = resolveAll(deps, registry);
  const root = path.dirname(consumer.path);

  const lockEntries = {};
  for (const [name, info] of resolved) {
    const copied = installOne(name, info, root);
    lockEntries[name] = {
      version: info.version,
      source: path.relative(root, info.source),
      files: copied,
    };
    process.stdout.write(`installed ${name}@${info.version} (${copied.length} file${copied.length === 1 ? "" : "s"})\n`);
  }

  const lock = {
    generatedBy: "yoopkg",
    packagesDir: PACKAGES_DIR,
    dependencies: lockEntries,
  };
  writeJson(path.join(root, LOCK_NAME), lock);
  process.stdout.write(`wrote ${LOCK_NAME}\n`);
}

function cmdList() {
  const lockPath = path.resolve(LOCK_NAME);
  if (!fs.existsSync(lockPath)) {
    process.stdout.write(`no ${LOCK_NAME} here - run \`yoopkg install\` first.\n`);
    return;
  }
  const lock = readJson(lockPath);
  const entries = Object.entries(lock.dependencies ?? {});
  if (entries.length === 0) {
    process.stdout.write("no packages installed.\n");
    return;
  }
  for (const [name, info] of entries) {
    const n = info.files.length;
    process.stdout.write(`${name}@${info.version}  (${n} file${n === 1 ? "" : "s"})\n`);
  }
}

function cmdRegistry() {
  const registry = loadRegistry();
  process.stdout.write(`registry: ${registry.path}\n`);
  const packages = registry.data.packages ?? {};
  const names = Object.keys(packages);
  if (names.length === 0) {
    process.stdout.write("(empty)\n");
    return;
  }
  for (const name of names) {
    const versions = Object.keys(packages[name]).sort();
    process.stdout.write(`${name}: ${versions.join(", ")}\n`);
  }
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "install":
      return cmdInstall();
    case "list":
      return cmdList();
    case "registry":
      return cmdRegistry();
    case undefined:
    case "-h":
    case "--help":
    case "help":
      return usage();
    default:
      fail(`unknown command "${cmd}". Try \`yoopkg help\`.`);
  }
}

main();
