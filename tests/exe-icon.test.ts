import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { icoImages, peIconGroups, verifyExeIcon } = await import(
  pathToFileURL(path.resolve("scripts/verify-exe-icon.mjs")).href
);

// In-memory PE fixtures test the resource reader; they are never written or executed.
function fixture(size = 32) {
  const png = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(size, 16);
  png.writeUInt32BE(size, 20);
  const ico = Buffer.alloc(22 + png.length);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = ico[7] = size === 256 ? 0 : size;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  png.copy(ico, 22);

  const pe = Buffer.alloc(0x600);
  pe.write("MZ");
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write("PE\0\0", 0x80);
  pe.writeUInt16LE(1, 0x86);
  pe.writeUInt16LE(240, 0x94);
  pe.writeUInt16LE(0x20b, 0x98);
  pe.writeUInt32LE(0x1000, 0x98 + 112 + 16);
  pe.writeUInt32LE(0x300, 0x98 + 112 + 20);
  const section = 0x98 + 240;
  pe.writeUInt32LE(0x1000, section + 12);
  pe.writeUInt32LE(0x300, section + 16);
  pe.writeUInt32LE(0x200, section + 20);
  const resource = pe.subarray(0x200);
  function directory(offset: number, entries: [number, number, boolean][]) {
    resource.writeUInt16LE(entries.length, offset + 14);
    entries.forEach(([id, link, nested], i) => {
      resource.writeUInt32LE(id, offset + 16 + i * 8);
      resource.writeUInt32LE(
        (link + (nested ? 0x80000000 : 0)) >>> 0,
        offset + 20 + i * 8,
      );
    });
  }
  directory(0, [
    [3, 0x30, true],
    [14, 0x70, true],
  ]);
  directory(0x30, [[1, 0x50, true]]);
  directory(0x50, [[1033, 0xb0, false]]);
  directory(0x70, [[1, 0x90, true]]);
  directory(0x90, [[1033, 0xc0, false]]);
  resource.writeUInt32LE(0x1000 + 0x100, 0xb0);
  resource.writeUInt32LE(png.length, 0xb4);
  resource.writeUInt32LE(0x1000 + 0x140, 0xc0);
  resource.writeUInt32LE(20, 0xc4);
  png.copy(resource, 0x100);
  ico.subarray(0, 6).copy(resource, 0x140);
  ico.subarray(6, 18).copy(resource, 0x146);
  resource.writeUInt16LE(1, 0x152);
  return { pe, ico };
}

test("PE verifier matches exact embedded original images including 256px entries", () => {
  for (const size of [16, 32, 256]) {
    const { pe, ico } = fixture(size);
    assert.deepEqual(verifyExeIcon(pe, ico), {
      ok: true,
      iconGroups: 1,
      sizes: [size],
      byteIdentical: true,
    });
  }
});

test("PE verifier rejects missing icons and mismatched artwork", () => {
  const { pe, ico } = fixture();
  const changed = Buffer.from(pe);
  changed[0x200 + 0x100 + 31] = 1;
  assert.throws(() => verifyExeIcon(changed, ico), /differs/);
  pe.writeUInt32LE(0, 0x98 + 112 + 16);
  assert.deepEqual(peIconGroups(pe), []);
  assert.throws(() => verifyExeIcon(pe, ico), /no embedded icon/);
});

test("PE and ICO malformed offsets, resource cycles and missing images fail closed", () => {
  const { pe, ico } = fixture();
  assert.throws(() => peIconGroups(pe.subarray(0, 50)));
  const cyclic = Buffer.from(pe);
  cyclic.writeUInt32LE(0x80000000, 0x200 + 20);
  assert.throws(() => peIconGroups(cyclic), /cycle/);
  const missing = Buffer.from(pe);
  missing.writeUInt16LE(9, 0x200 + 0x152);
  assert.throws(() => peIconGroups(missing), /missing icon/);
  const overlap = Buffer.from(ico);
  overlap.writeUInt32LE(0, 18);
  assert.throws(() => icoImages(overlap), /overlaps/);
  const wrongSize = Buffer.from(ico);
  wrongSize.writeUInt32BE(99, 22 + 16);
  assert.throws(() => icoImages(wrongSize), /width mismatch/);
});
