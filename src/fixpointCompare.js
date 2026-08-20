// Whether two linked stages are the same COMPILER OUTPUT.
//
// On Linux this is a plain byte comparison and nothing below runs. On macOS it
// cannot be, and the reason is worth stating precisely because it looks exactly
// like a miscompile when it is not: `clang -g` on Darwin does NOT put DWARF in
// the executable. It leaves the debug info in the intermediate object files and
// writes a DEBUG MAP into the symbol table - one `N_OSO` stab per translation
// unit, holding that object file's PATH and its MTIME. The driver puts those
// objects in randomly named temp files, so two links of one unchanged `.ll`
// disagree:
//
//     OSO ...T/yoopiler_boot-5c8653.o   mtime 0x6a869420
//     OSO ...T/yoopiler_boot-a83346.o   mtime 0x6a869429
//
// `LC_UUID` is a content hash over the linked image, so it moves with them, and
// the adhoc code signature ld64 attaches to every arm64 binary is a hash over
// the file INCLUDING those, so it moves too. Linking one `.ll` twice on an
// unchanged tree differs by 324 bytes for that reason alone.
//
// So the three regions below are normalized away, and NOTHING else is: the
// machine code, the data, the regular symbol table and every other load command
// are compared exactly as they are on Linux. A real disagreement between stage2
// and stage3 still fails this, which is the entire point of the check.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MH_MAGIC_64 = 0xfeedfacf;
const MACH_HEADER_64_SIZE = 32;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;

// The stage pair, compared. Returns "" when they match, else what differs.
export function compareStageBinaries(pathA, pathB) {
  if (process.platform !== "darwin") {
    return fs.readFileSync(pathA).equals(fs.readFileSync(pathB)) ? "" : "the binaries differ";
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-fixpoint-"));
  try {
    const a = normalizeMachO(pathA, path.join(work, "a"));
    const b = normalizeMachO(pathB, path.join(work, "b"));
    if (a.equals(b)) return "";
    if (a.length !== b.length) {
      return `the binaries differ in length (${a.length} vs ${b.length}) after normalizing the debug map, LC_UUID and the code signature`;
    }
    let n = 0;
    let first = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (first < 0) first = i;
        n++;
      }
    }
    return `the binaries differ in ${n} bytes (first at offset ${first}) with the debug map, LC_UUID and the code signature already normalized away, so this is a real disagreement`;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// A copy of `src` with the three non-reproducible regions zeroed, as bytes.
//
// `strip -S` drops the debug map and keeps the regular symbol table, which is
// what makes this narrower than it looks: symbol names and addresses still have
// to match. The UUID and the signature are zeroed in place rather than removed
// so that every following offset stays where it was and the comparison below
// stays a flat memcmp.
function normalizeMachO(src, dst) {
  fs.copyFileSync(src, dst);
  execFileSync("strip", ["-S", dst], { stdio: "ignore" });

  const buf = fs.readFileSync(dst);
  if (buf.length < MACH_HEADER_64_SIZE || buf.readUInt32LE(0) !== MH_MAGIC_64) {
    // Not a thin 64-bit Mach-O (a universal binary would be 0xcafebabe). Nothing
    // to normalize, and a byte comparison is still the honest answer.
    return buf;
  }

  const ncmds = buf.readUInt32LE(16);
  let off = MACH_HEADER_64_SIZE;
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > buf.length) break;
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmdsize < 8) break;
    if (cmd === LC_UUID) {
      buf.fill(0, off + 8, Math.min(off + 24, buf.length));
    } else if (cmd === LC_CODE_SIGNATURE) {
      const dataoff = buf.readUInt32LE(off + 8);
      const datasize = buf.readUInt32LE(off + 12);
      buf.fill(0, Math.min(dataoff, buf.length), Math.min(dataoff + datasize, buf.length));
    }
    off += cmdsize;
  }
  return buf;
}
