import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function slice(bytes, offset, length) {
  assert.ok(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= bytes.length,
    "Truncated icon or PE resource",
  );
  return bytes.subarray(offset, offset + length);
}
const u16 = (b, o) => slice(b, o, 2).readUInt16LE();
const u32 = (b, o) => slice(b, o, 4).readUInt32LE();

export function icoImages(bytes) {
  assert.equal(u16(bytes, 0), 0, "Invalid ICO header");
  assert.equal(u16(bytes, 2), 1, "Not an icon file");
  const count = u16(bytes, 4);
  assert.ok(count > 0 && count <= 256, "Invalid icon count");
  return Array.from({ length: count }, (_, i) => {
    const entry = slice(bytes, 6 + i * 16, 16);
    const width = entry[0] || 256,
      height = entry[1] || 256;
    const offset = u32(entry, 12),
      length = u32(entry, 8);
    assert.ok(offset >= 6 + count * 16, "Icon image overlaps directory");
    const png = slice(bytes, offset, length);
    assert.equal(
      png.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      "Expected PNG icon image",
    );
    assert.equal(slice(png, 16, 4).readUInt32BE(), width, "PNG width mismatch");
    assert.equal(
      slice(png, 20, 4).readUInt32BE(),
      height,
      "PNG height mismatch",
    );
    return {
      width,
      height,
      planes: u16(entry, 4),
      depth: u16(entry, 6),
      data: png,
    };
  });
}

/** Read-only PE parsing: never loads or executes the inspected binary. */
export function peIconGroups(bytes) {
  assert.equal(slice(bytes, 0, 2).toString(), "MZ", "Not a Windows executable");
  const pe = u32(bytes, 0x3c);
  assert.equal(
    slice(bytes, pe, 4).toString("hex"),
    "50450000",
    "Invalid PE signature",
  );
  const count = u16(bytes, pe + 6),
    optionalLength = u16(bytes, pe + 20),
    optional = pe + 24;
  const magic = u16(bytes, optional);
  assert.ok(magic === 0x10b || magic === 0x20b, "Unsupported PE format");
  const directories = optional + (magic === 0x20b ? 112 : 96);
  assert.ok(
    directories + 24 <= optional + optionalLength,
    "No resource directory",
  );
  const resourceRva = u32(bytes, directories + 16),
    resourceSize = u32(bytes, directories + 20);
  if (!resourceRva || !resourceSize) return [];
  const sections = Array.from({ length: count }, (_, i) => {
    const offset = optional + optionalLength + i * 40;
    return {
      rva: u32(bytes, offset + 12),
      size: u32(bytes, offset + 16),
      raw: u32(bytes, offset + 20),
    };
  });
  function fileOffset(rva, length) {
    const section = sections.find(
      (s) => rva >= s.rva && rva + length <= s.rva + s.size,
    );
    assert.ok(section, "Resource address is outside file-backed sections");
    const offset = section.raw + rva - section.rva;
    slice(bytes, offset, length);
    return offset;
  }
  const resource = slice(
    bytes,
    fileOffset(resourceRva, resourceSize),
    resourceSize,
  );
  const leaves = [];
  const seen = new Set();
  function walk(offset, keys) {
    assert.ok(
      keys.length < 4 && !seen.has(offset),
      "Invalid resource directory cycle/depth",
    );
    seen.add(offset);
    const length = u16(resource, offset + 12) + u16(resource, offset + 14);
    for (let i = 0; i < length; i++) {
      const entry = offset + 16 + i * 8;
      const id = u32(resource, entry),
        link = u32(resource, entry + 4);
      const key =
        id & 0x80000000
          ? slice(
              resource,
              (id & 0x7fffffff) + 2,
              u16(resource, id & 0x7fffffff) * 2,
            ).toString("utf16le")
          : id;
      const next = [...keys, key];
      if (link & 0x80000000) walk(link & 0x7fffffff, next);
      else {
        const rva = u32(resource, link),
          size = u32(resource, link + 4);
        leaves.push({
          keys: next,
          data: slice(bytes, fileOffset(rva, size), size),
        });
      }
    }
  }
  walk(0, []);
  return leaves
    .filter((e) => e.keys[0] === 14)
    .map((group) => {
      assert.equal(u16(group.data, 0), 0);
      assert.equal(u16(group.data, 2), 1);
      const n = u16(group.data, 4);
      assert.ok(n > 0 && n <= 256, "Invalid group icon count");
      return Array.from({ length: n }, (_, i) => {
        const entry = slice(group.data, 6 + i * 14, 14);
        const image = leaves.find(
          (e) =>
            e.keys[0] === 3 &&
            e.keys[1] === u16(entry, 12) &&
            e.keys[2] === group.keys[2],
        );
        assert.ok(image, "Group references a missing icon resource");
        assert.equal(
          image.data.length,
          u32(entry, 8),
          "Icon resource size mismatch",
        );
        return {
          width: entry[0] || 256,
          height: entry[1] || 256,
          planes: u16(entry, 4),
          depth: u16(entry, 6),
          data: image.data,
        };
      });
    });
}

export function verifyExeIcon(executable, icon) {
  const expected = icoImages(icon),
    groups = peIconGroups(executable);
  assert.ok(groups.length, "EXE has no embedded icon group");
  for (const group of groups) {
    assert.equal(
      group.length,
      expected.length,
      "Embedded icon size count mismatch",
    );
    for (let i = 0; i < group.length; i++)
      assert.deepEqual(
        group[i],
        expected[i],
        "Embedded icon differs from the converted original",
      );
  }
  return {
    ok: true,
    iconGroups: groups.length,
    sizes: expected.map((e) => e.width),
    byteIdentical: true,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv[2] === "--inspect") {
      const groups = peIconGroups(readFileSync(process.argv[3]));
      console.log(
        JSON.stringify({
          iconGroups: groups.length,
          sizes: groups.map((g) => g.map((e) => e.width)),
        }),
      );
    } else {
      assert.equal(
        process.argv.length,
        4,
        "Usage: verify-exe-icon.mjs <exe> <original.ico>",
      );
      console.log(
        JSON.stringify(
          verifyExeIcon(
            readFileSync(process.argv[2]),
            readFileSync(process.argv[3]),
          ),
        ),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
