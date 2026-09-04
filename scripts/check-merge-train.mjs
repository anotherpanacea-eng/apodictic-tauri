#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  BASE_REF, PolicyError, TRAIN_RE, canonical, exactKeys, git, gitResult, oid,
  parseStrictJson, positiveInteger, printable, refuseObjectRewrites,
  repositorySlug, resolveCommit,
} from "./train-policy-common.mjs";

const SKIP_RE = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true\s*$/im;

function parents(repo, commit) {
  const fields = String(git(repo, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/);
  if (fields.shift() !== commit) throw new PolicyError(`cannot inspect exact commit ${commit}`);
  return fields;
}
function tree(repo, commit) { return String(git(repo, ["rev-parse", "--verify", `${commit}^{tree}`])).trim(); }

function automaticMerge(repo, first, second) {
  const result = gitResult(repo, ["merge-tree", "--write-tree", "--name-only", "-z", "--messages", first, second], { encoding: null });
  if (![0, 1].includes(result.status)) throw new PolicyError(`git merge-tree failed: ${result.stderr.toString("utf8").trim()}`);
  const fields = result.stdout.toString("binary").split("\0");
  const automaticTree = fields[0];
  oid(automaticTree, "automatic merge tree");
  const boundary = fields.indexOf("", 1);
  if (boundary < 0) throw new PolicyError("git merge-tree omitted conflict-path terminator");
  const conflicts = new Set(fields.slice(1, boundary).map((item) => Buffer.from(item, "binary").toString("base64")));
  if ((result.status === 0) !== (conflicts.size === 0)) throw new PolicyError("git merge-tree conflict metadata is inconsistent");
  return { clean: result.status === 0, tree: automaticTree, conflicts };
}

function diffPaths(repo, first, second) {
  const raw = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", first, second], { encoding: null });
  return new Set(raw.toString("binary").split("\0").filter(Boolean).map((item) => Buffer.from(item, "binary").toString("base64")));
}

function treeEntries(repo, commit, wanted) {
  const raw = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], { encoding: null });
  const result = new Map();
  for (const record of raw.toString("binary").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new PolicyError("git ls-tree emitted malformed output");
    const metadata = record.slice(0, tab).split(" ");
    const key = Buffer.from(record.slice(tab + 1), "binary").toString("base64");
    if (wanted.has(key) && metadata[1] === "blob") result.set(key, metadata[2]);
  }
  return result;
}

function blob(repo, objectId) { return git(repo, ["cat-file", "blob", objectId], { encoding: null }); }
function markerWidths(content) {
  const text = content.toString("binary");
  const collect = (char, tail) => new Set([...text.matchAll(new RegExp(`^(${char}+)(?!${char})${tail}\\r?$`, "gm"))].map((m) => m[1].length));
  const starts = collect("<", "(?: .*)?");
  const middles = collect("=", "");
  const ends = collect(">", "(?: .*)?");
  return new Set([...starts].filter((width) => middles.has(width) && ends.has(width)));
}
function hasTriplet(content, width) {
  const text = content.toString("binary");
  const escaped = (char) => `\\${char}{${width}}(?!\\${char})`;
  return new RegExp(`^${escaped("<")}(?: .*)?\\r?$`, "m").test(text)
    && new RegExp(`^${escaped("=")}\\r?$`, "m").test(text)
    && new RegExp(`^${escaped(">")}(?: .*)?\\r?$`, "m").test(text);
}

function validateConflict(repo, commit, first, second, automaticTree, conflictPaths) {
  const changed = diffPaths(repo, automaticTree, tree(repo, commit));
  for (const item of changed) if (!conflictPaths.has(item)) throw new PolicyError("conflict resolution changed a non-conflict path");
  const automatic = treeEntries(repo, automaticTree, conflictPaths);
  const final = treeEntries(repo, commit, conflictPaths);
  const left = treeEntries(repo, first, conflictPaths);
  const right = treeEntries(repo, second, conflictPaths);
  for (const item of conflictPaths) {
    const autoId = automatic.get(item);
    const finalId = final.get(item);
    if (finalId === autoId && autoId !== left.get(item) && autoId !== right.get(item)) {
      throw new PolicyError("conflict path remains at Git's unmaterialized automatic entry");
    }
    if (autoId && finalId) {
      const widths = new Set([7, ...markerWidths(blob(repo, autoId))]);
      const finalContent = blob(repo, finalId);
      if ([...widths].some((width) => hasTriplet(finalContent, width))) {
        throw new PolicyError("conflict path retains a complete conflict-marker triplet");
      }
    }
  }
}

export function loadInventory(file) {
  const value = parseStrictJson(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PolicyError("inventory root must be an object");
  return value;
}

export function verifyTrain(repo, inventory) {
  refuseObjectRewrites(repo);
  exactKeys(inventory, ["schema", "base", "base_ref", "head", "steps"], "inventory");
  if (inventory.schema !== "apodictic-tauri-merge-train/1") throw new PolicyError("unknown inventory schema");
  if (inventory.base_ref !== BASE_REF) throw new PolicyError(`base_ref must be ${BASE_REF}`);
  const base = oid(inventory.base, "base");
  const head = oid(inventory.head, "head");
  if (resolveCommit(repo, base, "base") !== base || resolveCommit(repo, head, "head") !== head) throw new PolicyError("base/head do not resolve exactly");
  if (String(git(repo, ["show-ref", "--verify", "--hash", BASE_REF])).trim() !== base) throw new PolicyError("base_ref moved after inventory freeze");
  if (resolveCommit(repo, "HEAD", "HEAD") !== head) throw new PolicyError("worktree HEAD is not inventory head");
  const branch = String(git(repo, ["branch", "--show-current"])).trim();
  if (!TRAIN_RE.test(branch)) throw new PolicyError("current branch is not a bounded train ref");
  if (!Array.isArray(inventory.steps) || inventory.steps.length < 1 || inventory.steps.length > 2_147_483_647) throw new PolicyError("steps must be a bounded nonempty array");
  if (SKIP_RE.test(String(git(repo, ["log", "-1", "--format=%B", head])))) throw new PolicyError("train head contains a CI skip instruction");

  const normalized = [];
  const prs = new Set(); const heads = new Set(); const commits = new Set(); const labels = new Set(); const branchIdentities = new Set();
  for (let index = 0; index < inventory.steps.length; index += 1) {
    const step = inventory.steps[index];
    if (step?.kind === "constituent") {
      exactKeys(step, ["kind", "pr", "head_repo", "head_ref", "head", "merge", "tree_mode", "resolution"], `step ${index}`);
      const pr = positiveInteger(step.pr, `step ${index} pr`);
      const candidate = oid(step.head, `step ${index} head`);
      const merge = oid(step.merge, `step ${index} merge`);
      repositorySlug(step.head_repo, `step ${index} head_repo`);
      printable(step.head_ref, `step ${index} head_ref`);
      const refCheck = gitResult(repo, ["check-ref-format", "--branch", step.head_ref]);
      if (refCheck.status !== 0) throw new PolicyError(`step ${index} head_ref is not a valid branch`);
      const branchIdentity = `${step.head_repo.toLocaleLowerCase("en-US")}\0${step.head_ref.toLocaleLowerCase("en-US")}`;
      if (branchIdentities.has(branchIdentity)) throw new PolicyError("duplicate constituent branch identity");
      if (step.tree_mode === "clean") {
        if (step.resolution !== null) throw new PolicyError("clean merge resolution must be null");
      } else if (step.tree_mode === "conflict-resolution") printable(step.resolution, "conflict resolution");
      else throw new PolicyError("unknown tree_mode");
      if (prs.has(pr) || heads.has(candidate) || commits.has(candidate) || commits.has(merge)) throw new PolicyError("duplicate constituent identity");
      if (resolveCommit(repo, candidate, "constituent") !== candidate || resolveCommit(repo, merge, "merge") !== merge) throw new PolicyError("constituent objects do not resolve exactly");
      const ancestor = gitResult(repo, ["merge-base", "--is-ancestor", candidate, base]);
      if (ancestor.status === 0) throw new PolicyError("constituent is already in train base");
      if (ancestor.status !== 1) throw new PolicyError("cannot compare constituent with base");
      prs.add(pr); heads.add(candidate); commits.add(merge); branchIdentities.add(branchIdentity);
      normalized.push({ ...step });
    } else if (step?.kind === "train") {
      exactKeys(step, ["kind", "label", "commit"], `step ${index}`);
      const label = printable(step.label, `step ${index} label`);
      const commit = oid(step.commit, `step ${index} commit`);
      if (labels.has(label) || commits.has(commit) || heads.has(commit)) throw new PolicyError("duplicate train-only identity");
      if (resolveCommit(repo, commit, "train-only commit") !== commit) throw new PolicyError("train-only commit does not resolve exactly");
      labels.add(label); commits.add(commit); normalized.push({ ...step });
    } else throw new PolicyError(`step ${index} has unknown kind`);
  }
  if (heads.size < 1) throw new PolicyError("train requires at least one constituent");

  let current = head; let conflicts = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const step = normalized[index];
    if (step.kind === "constituent") {
      if (current !== step.merge) throw new PolicyError(`step ${index} is not at the expected first-parent position`);
      const pair = parents(repo, current);
      if (pair.length !== 2 || pair[1] !== step.head) throw new PolicyError(`step ${index} has wrong merge parents`);
      const automatic = automaticMerge(repo, pair[0], pair[1]);
      if (step.tree_mode === "clean") {
        if (!automatic.clean || tree(repo, current) !== automatic.tree) throw new PolicyError(`step ${index} is not Git's exact clean merge`);
      } else {
        if (automatic.clean) throw new PolicyError(`step ${index} claims a conflict but merges cleanly`);
        validateConflict(repo, current, pair[0], pair[1], automatic.tree, automatic.conflicts);
        conflicts += 1;
      }
      current = pair[0];
    } else {
      if (current !== step.commit) throw new PolicyError(`train-only step ${index} is out of order`);
      const prior = parents(repo, current);
      if (prior.length !== 1) throw new PolicyError("train-only step must be single-parent");
      current = prior[0];
    }
  }
  if (current !== base) throw new PolicyError("first-parent inventory does not end at base");
  return {
    base, base_ref: BASE_REF, conflict_resolution_count: conflicts,
    constituent_count: heads.size, head,
    schema: "apodictic-tauri-merge-train-receipt/1",
    step_count: normalized.length, train_commit_count: labels.size,
  };
}

function parseArgs(argv) {
  const output = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--repo" && output.repo === process.cwd()) output.repo = argv[i + 1];
    else if (argv[i] === "--inventory" && output.inventory === undefined) output.inventory = argv[i + 1];
    else throw new PolicyError("usage: [--repo PATH] --inventory FILE");
  }
  if (!output.inventory) throw new PolicyError("inventory is required");
  return output;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    process.stdout.write(`merge-train: ${canonical(verifyTrain(args.repo, loadInventory(args.inventory)))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`merge-train: REFUSED: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
