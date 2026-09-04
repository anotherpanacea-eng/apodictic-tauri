import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export class PolicyError extends Error {}

export const REPOSITORY = "anotherpanacea-eng/apodictic-tauri";
export const REMOTE_URL = "https://github.com/anotherpanacea-eng/apodictic-tauri.git";
export const BASE_REF = "refs/remotes/origin/main";
export const SYNC_REF = "chore/sync-gemini-web";
export const OID_RE = /^[0-9a-f]{40}$/;
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const TRAIN_RE = /^train\/[a-z0-9][a-z0-9._-]{0,62}$/i;
export const TRAIN_PREFIX_RE = /^train\//i;

export function same(left, right) {
  return typeof left === "string" && typeof right === "string"
    && left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

class StrictJsonParser {
  constructor(text) { this.text = text; this.index = 0; }
  fail(message) { throw new PolicyError(`invalid JSON at byte ${this.index}: ${message}`); }
  whitespace() { while (/[ \t\r\n]/.test(this.text[this.index] ?? "")) this.index += 1; }
  parse() {
    this.whitespace();
    const value = this.value();
    this.whitespace();
    if (this.index !== this.text.length) this.fail("trailing content");
    return value;
  }
  value() {
    this.whitespace();
    const char = this.text[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (this.text.startsWith(literal, this.index)) { this.index += literal.length; return value; }
    }
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (match) { this.index += match[0].length; return Number(match[0]); }
    this.fail("expected value");
  }
  string() {
    const start = this.index++;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index++];
      if (!escaped && char === '"') {
        try { return JSON.parse(this.text.slice(start, this.index)); }
        catch { this.fail("malformed string"); }
      }
      if (!escaped && char.charCodeAt(0) < 0x20) this.fail("control character in string");
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    this.fail("unterminated string");
  }
  object() {
    const result = {};
    const seen = new Set();
    this.index += 1; this.whitespace();
    if (this.text[this.index] === "}") { this.index += 1; return result; }
    while (true) {
      if (this.text[this.index] !== '"') this.fail("object key must be a string");
      const key = this.string();
      if (seen.has(key)) this.fail(`duplicate member ${JSON.stringify(key)}`);
      seen.add(key); this.whitespace();
      if (this.text[this.index++] !== ":") this.fail("expected colon");
      result[key] = this.value(); this.whitespace();
      const char = this.text[this.index++];
      if (char === "}") return result;
      if (char !== ",") this.fail("expected comma or object end");
      this.whitespace();
    }
  }
  array() {
    const result = [];
    this.index += 1; this.whitespace();
    if (this.text[this.index] === "]") { this.index += 1; return result; }
    while (true) {
      result.push(this.value()); this.whitespace();
      const char = this.text[this.index++];
      if (char === "]") return result;
      if (char !== ",") this.fail("expected comma or array end");
      this.whitespace();
    }
  }
}

export function parseStrictJson(text) {
  if (typeof text !== "string") throw new PolicyError("JSON input must be text");
  return new StrictJsonParser(text).parse();
}

export function exactKeys(value, expected, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`${where} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) {
    throw new PolicyError(`${where} keys must be exactly ${wanted.join(",")}`);
  }
}

export function oid(value, name) {
  if (typeof value !== "string" || !OID_RE.test(value) || /^0+$/.test(value)) {
    throw new PolicyError(`${name} must be a canonical nonzero lowercase 40-hex object id`);
  }
  return value;
}

export function positiveInteger(value, name, maximum = 2_147_483_647) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PolicyError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

export function boundedDecimal(value, name, maximum) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(maximum)) {
    throw new PolicyError(`${name} must be a canonical bounded positive ASCII decimal`);
  }
  return value;
}

export function safeGitEnvironment(extra = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

export function gitResult(repo, args, { encoding = "utf8", extraEnv = {} } = {}) {
  const result = spawnSync("git", ["--no-replace-objects", "-C", path.resolve(repo), ...args], {
    env: safeGitEnvironment(extraEnv), encoding, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw new PolicyError(`git ${args.join(" ")} failed: ${result.error.message}`);
  return result;
}

export function git(repo, args, options = {}) {
  const result = gitResult(repo, args, options);
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new PolicyError(`git ${args.join(" ")} failed: ${String(detail).trim()}`);
  }
  return result.stdout;
}

export function resolveCommit(repo, value, name) {
  if (typeof value !== "string" || value.startsWith("-") || /[\0\r\n]/.test(value)) {
    throw new PolicyError(`unsafe ${name}`);
  }
  return String(git(repo, ["rev-parse", "--verify", `${value}^{commit}`])).trim();
}

export function refuseObjectRewrites(repo, { allowShallow = false } = {}) {
  if (String(git(repo, ["for-each-ref", "--format=%(refname)", "refs/replace"])).trim()) {
    throw new PolicyError("repository contains replacement refs");
  }
  for (const relative of ["info/grafts", "objects/info/alternates"]) {
    let target = String(git(repo, ["rev-parse", "--git-path", relative])).trim();
    if (!path.isAbsolute(target)) target = path.join(path.resolve(repo), target);
    if (fs.existsSync(target)) throw new PolicyError(`repository contains ${relative}`);
  }
  const local = gitResult(repo, ["config", "--local", "--get-regexp", "^(extensions\\.partialClone|remote\\..*\\.promisor|core\\.alternateRefsCommand)$"]);
  if (local.status === 0 && String(local.stdout).trim()) throw new PolicyError("repository contains promisor or alternate-object config");
  if (![0, 1].includes(local.status)) throw new PolicyError("could not inspect local object config");
  const shallow = String(git(repo, ["rev-parse", "--is-shallow-repository"])).trim();
  if (!allowShallow && shallow === "true") throw new PolicyError("repository is shallow");
}

export function printable(value, name, maximum = 200) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !/^[\x20-\x7e]+$/.test(value)) {
    throw new PolicyError(`${name} must be printable ASCII of length 1-${maximum}`);
  }
  return value;
}

export function repositorySlug(value, name = "repository") {
  if (typeof value !== "string" || !REPO_RE.test(value)) throw new PolicyError(`${name} must be an owner/name slug`);
  return value;
}
