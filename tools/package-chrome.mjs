import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionRoot = path.join(repoRoot, "extension");
const outputDir = path.join(repoRoot, "chrome-package");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const outputPath = path.join(outputDir, `build-inbox-${packageJson.version}-chrome-store.zip`);

let crcTable;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function zip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = file.data;
    const crc = crc32(data);

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name
    ]);

    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(centralStart),
    u16(0)
  ]);

  return Buffer.concat([...localParts, central, end]);
}

async function collectFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, relativePath)));
      continue;
    }

    let data = await readFile(fullPath);
    if (relativePath === "manifest.json") {
      const manifest = JSON.parse(data.toString("utf8"));
      delete manifest.key;
      data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
    files.push({ name: relativePath, data });
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

const files = await collectFiles(extensionRoot);
const manifestFile = files.find((file) => file.name === "manifest.json");
if (!manifestFile) {
  throw new Error("Chrome Store package must include manifest.json at the ZIP root.");
}

const manifest = JSON.parse(manifestFile.data.toString("utf8"));
if (manifest.key) {
  throw new Error("Chrome Store package still contains manifest.key.");
}

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, zip(files));
console.log(outputPath);
