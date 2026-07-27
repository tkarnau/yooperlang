// Builds a standalone yoopiler binary using Node's Single Executable
// Application support. Run with `npm run build:sea`.
//
// Output layout (dist/yoopiler-<platform>-<arch>/):
//
//   bin/yoopiler_alpha      the binary: a copy of the node runtime with our
//                           bundled compiler injected into it
//   lib/std/                the .yoop standard library
//   lib/runtime/            the C runtime sources handed to clang
//   lib/astViewerTemplate.html
//
// The data files stay OUTSIDE the binary on purpose. std/ could be embedded
// as SEA assets, but runtime/*.c cannot: clang is a separate process and needs
// real paths on a real filesystem. Rather than embed one and not the other,
// both live in lib/ and src/install_root.js finds them relative to the
// executable. Anything under lib/ can be edited in place, which is also a
// convenient debugging property.
//
// clang remains a hard runtime dependency. This packages the compiler, not
// the toolchain underneath it.
//
// Not cross-platform: SEA works by copying the *running* node binary, so this
// produces a binary for the machine it runs on. Build on each target (a CI
// matrix does this fine).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(repoRoot, "build");
const target = `yoopiler-${process.platform}-${process.arch}`;
const distDir = path.join(repoRoot, "dist", target);
const binName = process.platform === "win32" ? "yoopiler_alpha.exe" : "yoopiler_alpha";
const binPath = path.join(distDir, "bin", binName);

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
}

function step(msg) {
  process.stdout.write(`\n==> ${msg}\n`);
}

// 1. Bundle. SEA only accepts a CommonJS entry point, and this codebase is
//    ESM, so esbuild does the format conversion as well as the bundling.
//    Every import collapses into one file; there is no node_modules to ship
//    because the compiler has no runtime dependencies.
step("bundling src/yoopiler.js -> build/yoopiler.cjs");
fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(repoRoot, "src", "yoopiler.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: path.join(buildDir, "yoopiler.cjs"),
  logLevel: "info",
  // src/install_root.js reads import.meta.url, which a CJS bundle can't
  // provide. That is expected and handled: it guards the read and falls back
  // to process.execPath, which is the right answer for a packaged binary
  // anyway. Silence the warning so a real one stands out.
  logOverride: { "empty-import-meta": "silent" },
});

// 2. Build the SEA blob: the bundle plus the metadata node needs to run it.
//    useSnapshot is off - it runs the main script at build time to snapshot
//    the heap, which our entry (it calls main() on load) can't survive.
step("building SEA blob");
const seaConfig = path.join(buildDir, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(buildDir, "yoopiler.cjs"),
      output: path.join(buildDir, "sea.blob"),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ),
);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 3. Copy the node binary and inject the blob into it. On macOS the copy has
//    to be un-signed before injection and ad-hoc re-signed after, or the
//    kernel refuses to exec a binary whose signature no longer matches.
step(`injecting into a copy of ${process.execPath}`);
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, "bin"), { recursive: true });
fs.copyFileSync(process.execPath, binPath);
fs.chmodSync(binPath, 0o755);

if (process.platform === "darwin") {
  try {
    run("codesign", ["--remove-signature", binPath], { stdio: "ignore" });
  } catch {
    // Unsigned already; nothing to strip.
  }
}

const postjectArgs = [
  path.join(repoRoot, "node_modules", "postject", "dist", "cli.js"),
  binPath,
  "NODE_SEA_BLOB",
  path.join(buildDir, "sea.blob"),
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
// Mach-O needs the blob in a named segment; ELF and PE don't take this flag.
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run("node", postjectArgs);

if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", binPath]);
}

// 4. Stage the data files the binary reads at run time. install_root.js
//    probes <exeDir>/../lib for exactly this layout.
step("staging lib/ (std, runtime, assets)");
fs.cpSync(path.join(repoRoot, "std"), path.join(distDir, "lib", "std"), {
  recursive: true,
});
fs.cpSync(path.join(repoRoot, "runtime"), path.join(distDir, "lib", "runtime"), {
  recursive: true,
  // The C runtime's own test sources are not needed to compile yoop programs.
  filter: (src) => path.basename(src) !== "tests",
});
fs.copyFileSync(
  path.join(repoRoot, "src", "astViewerTemplate.html"),
  path.join(distDir, "lib", "astViewerTemplate.html"),
);

// 4b. Sample programs. Whatever sits in packaging/samples/ ships as samples/,
//     copied wholesale so adding a program needs no edit here. Compiled
//     output is extensionless, so skip anything without a suffix rather than
//     shipping stale binaries someone left behind after a test run.
step("staging samples/");
const samplesSrc = path.join(repoRoot, "packaging", "samples");
if (fs.existsSync(samplesSrc)) {
  fs.cpSync(samplesSrc, path.join(distDir, "samples"), {
    recursive: true,
    filter: (src) => {
      if (fs.statSync(src).isDirectory()) return !src.endsWith(".dSYM");
      // The drop zone's own README documents the build process for whoever
      // maintains this repo. It would only confuse the recipient.
      if (src === path.join(samplesSrc, "README.md")) return false;
      return path.extname(src) !== "";
    },
  });
  const count = fs
    .readdirSync(path.join(distDir, "samples"))
    .filter((f) => f.endsWith(".yoop")).length;
  process.stdout.write(`    ${count} .yoop sample(s)\n`);
} else {
  process.stdout.write("    (packaging/samples not found, skipping)\n");
}

// 4c. The VS Code extension, so the recipient gets syntax highlighting and
//     the language server. node_modules comes along (~2.5 MB, next to a
//     ~110 MB binary) because vscode-languageclient has to be present for the
//     extension to load, and the recipient may not have npm.
//
//     The extension finds the binary at ../../bin/ relative to itself, which
//     is exactly the layout produced here, so this needs no configuration.
step("staging editor/vscode/");
fs.cpSync(
  path.join(repoRoot, "editors", "vscode"),
  path.join(distDir, "editor", "vscode"),
  {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.git`),
  },
);
if (!fs.existsSync(path.join(distDir, "editor", "vscode", "node_modules"))) {
  process.stdout.write(
    "    WARNING: editors/vscode/node_modules is missing - the extension will\n" +
      "    fail to load for the recipient. Run `npm install` in editors/vscode.\n",
  );
}

// 4d. Editor instructions. Kept as a file in packaging/ rather than inlined
//     here because it is long prose that wants ordinary editing.
step("writing EDITOR_SETUP.md");
fs.copyFileSync(
  path.join(repoRoot, "packaging", "editor_setup.md"),
  path.join(distDir, "EDITOR_SETUP.md"),
);

// A README for whoever receives this directory. The macOS quarantine step is
// the one that matters: a downloaded ad-hoc-signed binary is SIGKILLed by
// Gatekeeper with no message at all, which is impossible to guess at.
step("writing INSTALL.md");
const macNotes = `
## 1. Clear the quarantine flag (macOS only, but required)

I haven't purchased the codesign stuff yet, while I hand out this test alpha.
macOS flags anything downloaded from a browser, mail client, or chat app. This
binary is ad-hoc signed rather than notarized, so Gatekeeper kills it on sight
with NO error message - it just exits with status 137. Run this once, from the
directory holding this file:

    xattr -dr com.apple.quarantine .

If you got this over AirDrop or a USB stick, the flag may not be set and you
can skip it. Running it anyway is harmless.
`;

fs.writeFileSync(
  path.join(distDir, "INSTALL.md"),
  `# yoopiler (${target})

A compiler for Yooperlang. Compiles a .yoop file to a native executable.
${process.platform === "darwin" ? macNotes : ""}
## ${process.platform === "darwin" ? "2" : "1"}. Install clang

yoopiler emits LLVM IR and shells out to clang to assemble and link it, so
clang has to be present. This is the one dependency it can't bring along.

    macOS    xcode-select --install
    Debian   sudo apt install clang
    Fedora   sudo dnf install clang
    Windows  install LLVM from https://releases.llvm.org

Check it worked: \`clang --version\`. If clang lives somewhere unusual, set
YOOP_CLANG to its full path instead.

## ${process.platform === "darwin" ? "3" : "2"}. Run it

Try one of the included programs first:

    ./bin/${binName} samples/hello.yoop
    ./samples/hello

Then your own:

    ./bin/${binName} yourprogram.yoop
    ./yourprogram

The compiler writes the executable next to your source file, with the .yoop
extension dropped. Use \`-o path\` to put it somewhere else.

To run it from anywhere, add the bin directory to your PATH:

    export PATH="$(pwd)/bin:$PATH"

Put that in your shell profile (~/.zshrc, ~/.bashrc) to make it permanent.

## Editor support (optional)

See EDITOR_SETUP.md for syntax highlighting, inline error checking, and
debugging in VS Code. The extension is in \`editor/vscode/\` and needs no
network access to install.

## What is in here

    bin/            the compiler
    lib/            standard library and C runtime it reads at compile time
    samples/        example programs to start from
    editor/vscode/  VS Code extension (see EDITOR_SETUP.md)

## Keep this directory intact

\`bin/\` and \`lib/\` have to stay siblings. The binary locates the standard
library and C runtime relative to itself, so moving the whole directory is
fine but moving the binary out on its own is not.

## Requirements

- ${process.platform === "darwin" ? "macOS 13.5 or newer, Apple Silicon (arm64)" : `${process.platform} / ${process.arch}`}
- clang (see above)
- Node.js is NOT required. It is baked into the binary.

## Options

    --keep-ir        keep the generated .ll and print its path
    --dump-ast       write an HTML AST viewer
    --track-heap     instrument heap alloc/free and dump a report at exit
    --list-attributes

## Environment variables

    YOOP_CLANG         full path to clang, if it is not on PATH
    YOOP_STD_ROOT      override the standard library location
    YOOP_RUNTIME_DIR   override the C runtime location
`,
);

// 5. Prove it actually runs, rather than trusting that the bytes landed.
//    --list-attributes exercises argument parsing and the attribute registry
//    without needing clang or an input file.
step("verifying");
const probe = execFileSync(binPath, ["--list-attributes"], { encoding: "utf8" });
if (!probe.includes("known attributes")) {
  console.error("verification failed - unexpected output:\n" + probe);
  process.exit(1);
}

const sizeMB = (fs.statSync(binPath).size / 1024 / 1024).toFixed(1);
process.stdout.write(
  `\nbuilt ${path.relative(repoRoot, binPath)} (${sizeMB} MB)\n` +
    `  data files: ${path.relative(repoRoot, path.join(distDir, "lib"))}\n` +
    `  run it: ${path.relative(repoRoot, binPath)} yourprogram.yoop\n` +
    `  clang is still required on PATH (or set YOOP_CLANG).\n`,
);
