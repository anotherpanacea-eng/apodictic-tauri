import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256File(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`canonical hash requires a regular file: ${filePath}`);
  }
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Hash a directory using the producer/consumer payload contract:
 * sorted POSIX-relative path + NUL + file bytes + NUL for every regular file.
 *
 * Missing roots retain the historical `null` result. Existing roots and all
 * descendants must be real directories or regular files; symlinks and other
 * filesystem object types are rejected rather than followed or hashed.
 */
function treeFiles(directory) {
  if (!fs.existsSync(directory)) return null;

  const rootStat = fs.lstatSync(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`canonical hash root must be a real directory: ${directory}`);
  }

  const files = [];
  function walk(currentDirectory, relativeDirectory) {
    for (const name of fs.readdirSync(currentDirectory).sort()) {
      const absolutePath = path.join(currentDirectory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`canonical hash rejects symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push([relativePath, absolutePath]);
      } else {
        throw new Error(`canonical hash rejects non-regular file: ${relativePath}`);
      }
    }
  }
  walk(directory, "");
  files.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

  return files;
}

export function manifestTreeHashSchema(value, { allowLegacy = false } = {}) {
  if (value === undefined && allowLegacy === true) return "legacy-nul-delimited-v1";
  if (value === "apodictic-tree-sha256-v2") return value;
  throw new Error(`unsupported payload manifest tree hash schema: ${String(value)}`);
}

export function requireV2TreeHashLock(lock) {
  if (lock?.tree_hash_schema !== "apodictic-tree-sha256-v2") {
    throw new Error("lock lacks the collision-unambiguous tree hash schema");
  }
  return lock;
}

export function legacyHashTree(directory) {
  const files = treeFiles(directory);
  if (files === null) return null;
  const hash = createHash("sha256");
  for (const [relativePath, absolutePath] of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function uint64(value) {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

/**
 * Collision-unambiguous v2 framing: domain tag, entry count, then byte-length-prefixed
 * UTF-8 path and content for every sorted regular file. The lengths make file boundaries
 * independent of arbitrary NUL bytes in either file names or contents.
 */
export function hashTree(directory) {
  const files = treeFiles(directory);
  if (files === null) return null;
  const hash = createHash("sha256");
  hash.update("apodictic-tree-sha256-v2\0");
  hash.update(uint64(files.length));
  for (const [relativePath, absolutePath] of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const content = fs.readFileSync(absolutePath);
    hash.update(uint64(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64(content.length));
    hash.update(content);
  }
  return hash.digest("hex");
}
