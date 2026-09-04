#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  PolicyError, SYNC_REF, canonical, positiveInteger, repositorySlug, same,
} from "./train-policy-common.mjs";

function systemRunner(args) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw new PolicyError(`${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) throw new PolicyError(`${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  return String(result.stdout);
}

function query(repository, owner, runner) {
  const endpoint = `repos/${repository}/pulls?state=open&base=main&head=${encodeURIComponent(`${owner}:${SYNC_REF}`)}&per_page=100`;
  let value;
  try { value = JSON.parse(runner(["gh", "api", endpoint])); }
  catch (error) { throw new PolicyError(`cannot resolve sync PRs: ${error.message}`); }
  if (!Array.isArray(value)) throw new PolicyError("sync PR query did not return an array");
  return value.filter((pull) => same(pull?.base?.ref, "main")
    && same(pull?.head?.ref, SYNC_REF)
    && same(pull?.head?.repo?.full_name, repository));
}

export function ensureSyncPrDraft(repository, runner = systemRunner) {
  repositorySlug(repository);
  const owner = repository.split("/")[0];
  const matches = query(repository, owner, runner);
  if (matches.length > 1) throw new PolicyError("multiple exact sync PRs are open");
  if (matches.length === 0) {
    return {
      actions: [], base_ref: "main", draft: null, head_ref: null, head_repo: null,
      pr: null, removed_labels: [], repository,
      schema: "apodictic-tauri-sync-draft/1",
    };
  }
  const pull = matches[0];
  const pr = positiveInteger(pull.number, "pr");
  const actions = [];
  const removed = [];
  const labels = Array.isArray(pull.labels) ? pull.labels : [];
  for (const item of labels) {
    const name = item?.name;
    if (typeof name === "string" && same(name, "ci-ready")) {
      runner(["gh", "api", "-X", "DELETE", `repos/${repository}/issues/${pr}/labels/${encodeURIComponent(name)}`]);
      removed.push(name);
      if (!actions.includes("remove-ci-ready")) actions.push("remove-ci-ready");
    }
  }
  if (pull.draft !== true) {
    runner(["gh", "pr", "ready", String(pr), "--undo", "--repo", repository]);
    actions.push("convert-to-draft");
  }
  const after = query(repository, owner, runner);
  if (after.length !== 1) throw new PolicyError("sync PR changed identity during enforcement");
  const current = after[0];
  if (current.number !== pr || current.draft !== true) throw new PolicyError("sync PR draft readback failed");
  const remaining = Array.isArray(current.labels) ? current.labels : [];
  if (remaining.some((item) => typeof item?.name === "string" && same(item.name, "ci-ready"))) {
    throw new PolicyError("sync PR remains ci-ready after enforcement");
  }
  actions.push("verified");
  return {
    actions, base_ref: "main", draft: true, head_ref: SYNC_REF,
    head_repo: repository, pr, removed_labels: removed, repository,
    schema: "apodictic-tauri-sync-draft/1",
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 2 || argv[0] !== "--repository") throw new PolicyError("usage: --repository OWNER/REPO");
    process.stdout.write(`sync-pr-draft: ${canonical(ensureSyncPrDraft(argv[1]))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`sync-pr-draft: REFUSED: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
