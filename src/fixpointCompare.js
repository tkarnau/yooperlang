// Whether two linked stages are the same COMPILER OUTPUT.
//
// On Linux this is a plain byte comparison and nothing below runs. On macOS and
// on Windows it cannot be, and in both cases the reason is worth stating
// precisely because it looks exactly like a miscompile when it is not.
//
// WINDOWS. link.exe stamps the image with the time it ran, and identifies the
// PDB beside it by a freshly generated GUID, so two links of one unchanged
// `.ll` disagree in four places: the COFF TimeDateStamp, the TimeDateStamp on
// each debug directory entry, the 16-byte CodeView GUID, and the PDB PATH.
// That last one is why the same-basename-in-different-directories trick
// scripts/package_bootstrap.mjs relies on does not carry here: the path is IN
// the executable, so s2 and s3 differ by the byte that names the directory.
// Twenty bytes in total, not one of them emitted by the compiler.
//
// MACOS. `clang -g` on Darwin does NOT put DWARF in
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
  if (process.platform === "win32") {
    const a = normalizePe(fs.readFileSync(pathA));
    const b = normalizePe(fs.readFileSync(pathB));
    return describeDifference(a, b, "the link timestamps, the CodeView GUID and the PDB path");
  }
  if (process.platform !== "darwin") {
    return fs.readFileSync(pathA).equals(fs.readFileSync(pathB)) ? "" : "the binaries differ";
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "yoop-fixpoint-"));
  try {
    const a = normalizeMachO(pathA, path.join(work, "a"));
    const b = normalizeMachO(pathB, path.join(work, "b"));
    return describeDifference(a, b, "the debug map, LC_UUID and the code signature");
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


// Two normalized images, as the empty string or as what is left over.
//
// `normalized` names what was already taken out of the comparison, so a
// surviving difference can be reported as a REAL one rather than leaving the
// reader to wonder whether the normalizer simply missed something.
function describeDifference(a, b, normalized) {
  if (a.equals(b)) return "";
  if (a.length !== b.length) {
    return `the binaries differ in length (${a.length} vs ${b.length}) after normalizing ${normalized}`;
  }
  let n = 0;
  let first = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (first < 0) first = i;
      n++;
    }
  }
  return `the binaries differ in ${n} bytes (first at offset ${first}) with ${normalized} already normalized away, so this is a real disagreement`;
}

const DOS_MAGIC = 0x5a4d; // "MZ"
const PE_MAGIC = 0x00004550;
const PE32_MAGIC = 0x10b;
const PE32PLUS_MAGIC = 0x20b;
const DEBUG_DIRECTORY_INDEX = 6;
const DEBUG_ENTRY_SIZE = 28;
const DEBUG_TYPE_CODEVIEW = 2;

// A copy of `buf` with the regions link.exe will not make reproducible zeroed.
//
// Written against the file rather than shelled out to: the Windows equivalents
// of `strip` are not something a build machine is guaranteed to have, and the
// four regions sit at offsets the PE format states exactly.
//
// Anything that does not parse as a PE image is handed back untouched, which is
// deliberate - a byte comparison of a file this cannot read is still the honest
// answer, where a normalizer that quietly gave up would turn a real difference
// into a pass.
function normalizePe(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== DOS_MAGIC) return buf;
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== PE_MAGIC) return buf;

  const coff = peOff + 4;
  buf.writeUInt32LE(0, coff + 4); // TimeDateStamp

  const sectionCount = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  if (opt + optSize > buf.length) return buf;

  const magic = buf.readUInt16LE(opt);
  if (magic !== PE32PLUS_MAGIC && magic !== PE32_MAGIC) return buf;
  // link.exe leaves the CheckSum 0 for an executable, but zeroing it costs
  // nothing and keeps a build that asked for one honest.
  buf.writeUInt32LE(0, opt + 64);

  const dirs = opt + (magic === PE32PLUS_MAGIC ? 112 : 96);
  const debugEntry = dirs + DEBUG_DIRECTORY_INDEX * 8;
  if (debugEntry + 8 > buf.length) return buf;
  const debugRva = buf.readUInt32LE(debugEntry);
  const debugSize = buf.readUInt32LE(debugEntry + 4);
  if (debugRva === 0 || debugSize === 0) return buf;

  const sections = opt + optSize;
  const debugOff = rvaToOffset(buf, debugRva, sections, sectionCount);
  if (debugOff < 0) return buf;

  for (let i = 0; i + DEBUG_ENTRY_SIZE <= debugSize; i += DEBUG_ENTRY_SIZE) {
    const e = debugOff + i;
    if (e + DEBUG_ENTRY_SIZE > buf.length) break;
    buf.writeUInt32LE(0, e + 4); // this entry's TimeDateStamp
    if (buf.readUInt32LE(e + 12) !== DEBUG_TYPE_CODEVIEW) continue;
    // The CodeView record is "RSDS", a 16-byte GUID, a 4-byte age, then the PDB
    // path as NUL-terminated bytes. Everything past the signature names the PDB
    // rather than the code, so all of it goes.
    const dataSize = buf.readUInt32LE(e + 16);
    const dataOff = buf.readUInt32LE(e + 24);
    if (dataOff + dataSize > buf.length) continue;
    buf.fill(0, dataOff + 4, dataOff + dataSize);
  }
  return buf;
}

// A relative virtual address as an offset into the file, or -1.
function rvaToOffset(buf, rva, sections, count) {
  for (let i = 0; i < count; i++) {
    const s = sections + i * 40;
    if (s + 40 > buf.length) break;
    const virtualSize = buf.readUInt32LE(s + 8);
    const virtualAddress = buf.readUInt32LE(s + 12);
    const rawSize = buf.readUInt32LE(s + 16);
    const rawOffset = buf.readUInt32LE(s + 20);
    const span = Math.max(virtualSize, rawSize);
    if (rva >= virtualAddress && rva < virtualAddress + span) {
      return rawOffset + (rva - virtualAddress);
    }
  }
  return -1;
}
