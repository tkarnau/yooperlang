// Builds the standalone compiler and bundles it into a single zip that can be
// handed to someone directly. Run with `npm run package`.
//
// This wraps build_sea.mjs and adds the things a recipient needs that the
// build itself does not produce:
//
//   1. A verification pass over samples/ using the binary that was just built,
//      so a sample that does not compile fails the package instead of being
//      discovered by whoever receives it.
//   2. AI_SETUP.md, a runbook for an assistant helping someone install this.
//   3. The zip.
//
// The result is dist/<name>.zip, self-contained apart from clang.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = `yoopiler-${process.platform}-${process.arch}`;
const distDir = path.join(repoRoot, "dist", target);
const binName = process.platform === "win32" ? "yoopiler_alpha.exe" : "yoopiler_alpha";

const PLATFORM_HUMAN =
  {
    darwin: process.arch === "arm64" ? "macOS on Apple Silicon" : "macOS on Intel",
    linux: `Linux (${process.arch})`,
    win32: `Windows (${process.arch})`,
  }[process.platform] ?? `${process.platform} ${process.arch}`;

function step(msg) {
  process.stdout.write(`\n==> ${msg}\n`);
}

// 1. Build. Delegated wholesale so there is exactly one definition of what a
//    build is; this script only ever adds to its output.
step("building the standalone compiler");
execFileSync(process.execPath, [path.join(repoRoot, "scripts", "build_sea.mjs")], {
  stdio: "inherit",
  cwd: repoRoot,
});

const binPath = path.join(distDir, "bin", binName);
if (!fs.existsSync(binPath)) {
  console.error(`build did not produce ${binPath}`);
  process.exit(1);
}

// 2. Compile every shipped sample with the binary that was just built. A
//    sample that does not compile is worse than no sample: it reads as a
//    broken install to someone who has no way to tell the difference.
step("verifying samples compile");
const samplesDir = path.join(distDir, "samples");
const samples = fs.existsSync(samplesDir)
  ? fs.readdirSync(samplesDir).filter((f) => f.endsWith(".yoop"))
  : [];

if (samples.length === 0) {
  process.stdout.write("    no samples to verify\n");
}
const broken = [];
for (const sample of samples) {
  const abs = path.join(samplesDir, sample);
  try {
    execFileSync(binPath, [abs], { cwd: samplesDir, stdio: "pipe" });
    process.stdout.write(`    ok    ${sample}\n`);
  } catch (err) {
    const detail = [err.stdout, err.stderr]
      .filter(Boolean)
      .map((b) => b.toString().trim())
      .join("\n");
    process.stdout.write(`    FAIL  ${sample}\n`);
    broken.push({ sample, detail });
  }
}
if (broken.length > 0) {
  console.error(
    `\n${broken.length} sample(s) failed to compile. Fix them in packaging/samples/ ` +
      `or remove them; shipping a sample that does not build is worse than shipping none.\n`,
  );
  for (const { sample, detail } of broken) {
    console.error(`--- ${sample} ---\n${detail}\n`);
  }
  process.exit(1);
}

// Compiling a sample leaves an extensionless executable (and a .dSYM bundle on
// macOS) beside it. Those are build residue, not part of the package.
for (const entry of fs.readdirSync(samplesDir)) {
  const abs = path.join(samplesDir, entry);
  if (entry.endsWith(".dSYM")) {
    fs.rmSync(abs, { recursive: true, force: true });
  } else if (path.extname(entry) === "" && fs.statSync(abs).isFile()) {
    fs.rmSync(abs, { force: true });
  }
}

// 3. The AI runbook. Placeholders are substituted so the instructions name
//    this specific package rather than describing a generic one.
step("writing AI_SETUP.md");
const aiTemplate = fs.readFileSync(
  path.join(repoRoot, "packaging", "ai_setup.md"),
  "utf8",
);
const aiDoc = aiTemplate
  .replaceAll("{{TARGET}}", target)
  .replaceAll("{{BIN}}", binName)
  .replaceAll("{{PLATFORM_HUMAN}}", PLATFORM_HUMAN);
if (aiDoc.includes("{{")) {
  console.error("AI_SETUP.md still contains an unsubstituted {{placeholder}}");
  process.exit(1);
}
fs.writeFileSync(path.join(distDir, "AI_SETUP.md"), aiDoc);

// Point the human-facing README at it, since the whole value of the runbook is
// that someone finds it without being told it exists.
const installPath = path.join(distDir, "INSTALL.md");
const install = fs.readFileSync(installPath, "utf8");
fs.writeFileSync(
  installPath,
  install.replace(
    "## What is in here",
    `## Stuck? Hand it to an AI

AI_SETUP.md is written for an AI assistant. Paste its contents into Claude,
ChatGPT, or Cursor along with "help me get this set up" and it has everything
needed to walk you through it, including the failure modes that are otherwise
hard to diagnose.

## What is in here`,
  ),
);

// 4. Zip. `zip` is present by default on macOS and Linux; on Windows fall back
//    to PowerShell's Compress-Archive. Zipping the parent with a relative path
//    keeps <target>/ as the single top-level directory, so unpacking never
//    scatters files into the user's current directory.
step("zipping");
const version = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version;
const zipName = `yoopiler-alpha-${version}-${process.platform}-${process.arch}.zip`;
const zipPath = path.join(repoRoot, "dist", zipName);
fs.rmSync(zipPath, { force: true });

if (process.platform === "win32") {
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${distDir}' -DestinationPath '${zipPath}'`,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("zip", ["-qr", zipPath, target], {
    cwd: path.join(repoRoot, "dist"),
    stdio: "inherit",
  });
}

const zipMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
const rawMB = (
  execFileSync("du", ["-sk", distDir], { encoding: "utf8" }).split(/\s+/)[0] / 1024
).toFixed(1);

process.stdout.write(
  `\n${"=".repeat(64)}\n` +
    `package ready\n\n` +
    `  ${zipPath}\n` +
    `  ${zipMB} MB zipped (${rawMB} MB unpacked)\n\n` +
    `  platform:  ${PLATFORM_HUMAN}\n` +
    `  samples:   ${samples.length} verified\n` +
    `  contents:  bin/ lib/ samples/ editor/vscode/\n` +
    `             INSTALL.md EDITOR_SETUP.md AI_SETUP.md\n\n` +
    `Recipient needs clang, and on macOS must run\n` +
    `  xattr -dr com.apple.quarantine .\n` +
    `after unzipping, or the binary is killed silently.\n` +
    `${"=".repeat(64)}\n`,
);
