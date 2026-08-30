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
export function hashTree(directory) {
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

  const hash = createHash("sha256");
  for (const [relativePath, absolutePath] of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}
