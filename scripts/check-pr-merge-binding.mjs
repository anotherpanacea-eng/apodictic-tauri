#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PolicyError, boundedDecimal, canonical, git, oid, repositorySlug,
} from "./train-policy-common.mjs";

export function verifyBinding(repo, input) {
  const repository = repositorySlug(input.repository);
  const base = oid(input.base, "base");
  const head = oid(input.head, "head");
  const merge = oid(input.githubSha, "github-sha");
  if (input.job !== "validate") throw new PolicyError("job must be exactly validate");
  const runId = boundedDecimal(input.runId, "run-id", 9_223_372_036_854_775_807n);
  const runAttempt = boundedDecimal(input.runAttempt, "run-attempt", 999_999n);

  const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: null });
  if (status.length) throw new PolicyError("checkout is not clean");
  const current = String(git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (current !== merge) throw new PolicyError(`HEAD ${current} does not equal github-sha ${merge}`);
  const raw = String(git(repo, ["cat-file", "-p", "HEAD"]));
  const parents = raw.split("\n\n", 1)[0].split(/\r?\n/)
    .filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  if (parents.length !== 2 || parents.some((value) => !/^[0-9a-f]{40}$/.test(value))) {
    throw new PolicyError("GitHub checkout HEAD must have exactly two canonical parent headers");
  }
  if (parents[0] !== base || parents[1] !== head) {
    throw new PolicyError("merge parents do not match exact event base/head order");
  }
  return {
    base_sha: base,
    head_sha: head,
    job: "validate",
    repository,
    run_attempt: runAttempt,
    run_id: runId,
    schema: "apodictic-tauri-pr-merge-binding/1",
    synthetic_merge_sha: merge,
  };
}

function parseArgs(argv) {
  const result = { repo: process.cwd() };
  const names = new Map([
    ["--repo", "repo"], ["--repository", "repository"], ["--base", "base"],
    ["--head", "head"], ["--github-sha", "githubSha"], ["--job", "job"],
    ["--run-id", "runId"], ["--run-attempt", "runAttempt"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || index + 1 >= argv.length || result[key] !== undefined) throw new PolicyError("invalid or duplicate arguments");
    result[key] = argv[index + 1];
  }
  for (const key of ["repository", "base", "head", "githubSha", "job", "runId", "runAttempt"]) {
    if (result[key] === undefined) throw new PolicyError(`missing ${key}`);
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const receipt = verifyBinding(args.repo, args);
    process.stdout.write(`pr-merge-binding: ${canonical(receipt)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`pr-merge-binding: REFUSED: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
