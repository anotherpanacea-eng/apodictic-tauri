#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  PolicyError, REPOSITORY, SYNC_REF, TRAIN_PREFIX_RE, TRAIN_RE, boundedDecimal, canonical,
  exactKeys, oid, parseStrictJson, positiveInteger, repositorySlug, same,
} from "./train-policy-common.mjs";

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const RUN_RE = /^apodictic-tauri-ci pr=([1-9][0-9]*) action=(opened|synchronize|reopened|ready_for_review|converted_to_draft|labeled|unlabeled|closed) train=(true|false) ci-ready-event=(true|false)$/;
const RECEIPT_RE = /pr-merge-binding: (\{[^\r\n]*\})/g;

function workflowPath(value) {
  return value === WORKFLOW_PATH || (typeof value === "string"
    && /^\.github\/workflows\/ci\.yml@[A-Za-z0-9_./-]{1,255}$/.test(value));
}
function activity(run, pr, train) {
  const match = typeof run.display_title === "string" ? RUN_RE.exec(run.display_title) : null;
  if (!match || Number(match[1]) !== pr || (match[3] === "true") !== train) throw new PolicyError("run activity disagrees with current PR");
  const action = match[2]; const ciReady = match[4] === "true";
  if (!["labeled", "unlabeled"].includes(action) && ciReady) throw new PolicyError("non-label activity claims a ci-ready event");
  return { action, ciReady, noise: (action === "labeled" || action === "unlabeled") && (train || !ciReady) };
}
function validateNoise(run) {
  if (run.status !== "completed" || run.conclusion !== "skipped") throw new PolicyError("noise run is not completed/skipped");
  if (!Array.isArray(run.jobs) || run.jobs.length !== 1) throw new PolicyError("noise run must contain exactly one job record");
  const job = run.jobs[0]; exactKeys(job, ["name", "status", "conclusion", "log"], "noise job");
  if (job.name !== "validate" || job.status !== "completed" || job.conclusion !== "skipped" || job.log !== "") {
    throw new PolicyError("noise validate job is not completed/skipped/logless");
  }
}
function bindingReceipt(log) {
  if (typeof log !== "string") throw new PolicyError("job log must be text");
  const matches = [...log.matchAll(RECEIPT_RE)];
  if (matches.length !== 1) throw new PolicyError("job log must contain exactly one binding receipt");
  const receipt = parseStrictJson(matches[0][1]);
  exactKeys(receipt, ["schema", "repository", "job", "run_id", "run_attempt", "base_sha", "head_sha", "synthetic_merge_sha"], "binding receipt");
  return receipt;
}
function verifiedNoiseLog(job) {
  if (!Array.isArray(job.steps)) throw new PolicyError("noise job does not expose a steps array");
  if (job.steps.length !== 0) throw new PolicyError("noise job is not step-free");
  return "";
}

export function validateEvidence(evidence) {
  exactKeys(evidence, ["schema", "repository", "pr", "base_ref", "base_sha", "head_sha", "current", "runs"], "evidence");
  if (evidence.schema !== "apodictic-tauri-train-ci-evidence/1") throw new PolicyError("unknown evidence schema");
  const repository = repositorySlug(evidence.repository);
  const pr = positiveInteger(evidence.pr, "pr");
  if (evidence.base_ref !== "main") throw new PolicyError("base_ref must be main");
  const base = oid(evidence.base_sha, "base_sha"); const head = oid(evidence.head_sha, "head_sha");
  const current = evidence.current;
  exactKeys(current, ["draft", "head_repo", "head_ref", "labels", "merged", "state", "base_ref", "base_sha", "head_sha"], "current");
  if (current.base_ref !== "main" || current.base_sha !== base || current.head_sha !== head) throw new PolicyError("current PR base/head disagrees with evidence");
  if (current.draft !== false || current.state !== "open" || current.merged !== false) throw new PolicyError("PR is not open, unmerged, and promoted");
  repositorySlug(current.head_repo, "head_repo");
  if (typeof current.head_ref !== "string" || !Array.isArray(current.labels) || current.labels.some((item) => typeof item !== "string")) throw new PolicyError("current PR identity is malformed");
  const sameRepo = same(current.head_repo, repository);
  const train = sameRepo && TRAIN_PREFIX_RE.test(current.head_ref);
  if (train && !TRAIN_RE.test(current.head_ref)) throw new PolicyError("current train ref is not bounded and canonical");
  const sync = sameRepo && same(current.head_ref, SYNC_REF);
  const ciReady = current.labels.some((label) => same(label, "ci-ready"));
  const authorization = train ? "train" : (sameRepo && !sync && ciReady ? "standalone" : null);
  if (!authorization) throw new PolicyError("current PR is not authorized");
  if (!Array.isArray(evidence.runs) || evidence.runs.length < 1) throw new PolicyError("runs must be nonempty");
  const seen = new Set(); const clearance = [];
  for (const run of evidence.runs) {
    exactKeys(run, ["id", "attempt", "event", "path", "head_sha", "display_title", "status", "conclusion", "jobs"], "run");
    const id = boundedDecimal(run.id, "run id", 9_223_372_036_854_775_807n);
    boundedDecimal(run.attempt, "run attempt", 999_999n);
    if (seen.has(id)) throw new PolicyError("duplicate run id"); seen.add(id);
    if (run.event !== "pull_request" || !workflowPath(run.path) || run.head_sha !== head) throw new PolicyError("run event/path/head is wrong");
    if (activity(run, pr, train).noise) validateNoise(run); else clearance.push(run);
  }
  if (!clearance.length) throw new PolicyError("no clearance run exists");
  clearance.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  const selected = clearance.at(-1);
  if (selected.status !== "completed" || selected.conclusion !== "success") throw new PolicyError("newest clearance run is not successful");
  if (!Array.isArray(selected.jobs) || selected.jobs.length !== 1) throw new PolicyError("clearance must have exactly one job");
  const job = selected.jobs[0]; exactKeys(job, ["name", "status", "conclusion", "log"], "job");
  if (job.name !== "validate" || job.status !== "completed" || job.conclusion !== "success") throw new PolicyError("validate job did not succeed");
  const receipt = bindingReceipt(job.log);
  if (receipt.schema !== "apodictic-tauri-pr-merge-binding/1" || receipt.job !== "validate") throw new PolicyError("binding receipt schema/job is wrong");
  if (!same(receipt.repository, repository)) throw new PolicyError("binding receipt repository is wrong");
  if (receipt.run_id !== selected.id || receipt.run_attempt !== selected.attempt) throw new PolicyError("binding receipt run/attempt is wrong");
  if (receipt.base_sha !== base || receipt.head_sha !== head) throw new PolicyError("binding receipt base/head is wrong");
  const synthetic = oid(receipt.synthetic_merge_sha, "synthetic_merge_sha");
  return {
    authorization, base_ref: "main", base_sha: base, head_sha: head, job_count: 1,
    pr, repository, run_attempt: selected.attempt, run_id: selected.id,
    schema: "apodictic-tauri-train-ci-clearance/1",
    synthetic_merge_sha: synthetic, workflow_path: WORKFLOW_PATH,
  };
}

function run(args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new PolicyError(`${args.join(" ")} failed`);
  return String(result.stdout);
}
function json(args) { return JSON.parse(run(args)); }

export function collectLive(repository, pr, base, head, runner = { run, json }) {
  const pull = runner.json(["gh", "api", `repos/${repository}/pulls/${pr}`]);
  const current = {
    base_ref: pull?.base?.ref, base_sha: pull?.base?.sha, draft: pull?.draft,
    head_ref: pull?.head?.ref, head_repo: pull?.head?.repo?.full_name,
    head_sha: pull?.head?.sha, labels: (pull.labels ?? []).map((item) => item.name),
    merged: pull?.merged, state: pull?.state,
  };
  const rawRuns = runner.json(["gh", "api", `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`]).workflow_runs ?? [];
  const train = same(current.head_repo, repository) && TRAIN_PREFIX_RE.test(current.head_ref ?? "");
  const runs = rawRuns.map((raw) => ({
    id: String(raw.id), attempt: String(raw.run_attempt), event: raw.event, path: raw.path,
    head_sha: raw.head_sha, display_title: raw.display_title, status: raw.status,
    conclusion: raw.conclusion, jobs: [],
  }));
  const nonNoise = [];
  for (const item of runs) {
    const meta = activity(item, pr, train);
    if (!meta.noise) nonNoise.push(item);
    else {
      const jobs = runner.json(["gh", "api", `repos/${repository}/actions/runs/${item.id}/attempts/${item.attempt}/jobs?per_page=100`]).jobs ?? [];
      item.jobs = jobs.map((job) => ({
        name: job.name, status: job.status, conclusion: job.conclusion,
        log: verifiedNoiseLog(job),
      }));
    }
  }
  if (nonNoise.length) {
    nonNoise.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    const selected = nonNoise.at(-1);
    const jobs = runner.json(["gh", "api", `repos/${repository}/actions/runs/${selected.id}/attempts/${selected.attempt}/jobs?per_page=100`]).jobs ?? [];
    selected.jobs = jobs.map((job) => ({
      name: job.name, status: job.status, conclusion: job.conclusion,
      log: runner.run(["gh", "run", "view", selected.id, "--repo", repository, "--job", String(job.id), "--log"]),
    }));
  }
  return {
    schema: "apodictic-tauri-train-ci-evidence/1", repository, pr,
    base_ref: "main", base_sha: base, head_sha: head, current, runs,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const map = { "--evidence": "evidence", "--repository": "repository", "--pr": "pr", "--base": "base", "--head": "head" };
    const key = map[argv[i]]; if (!key || result[key] !== undefined || argv[i + 1] === undefined) throw new PolicyError("invalid arguments");
    result[key] = argv[i + 1];
  }
  if (!result.evidence && !(result.repository && result.pr && result.base && result.head)) throw new PolicyError("use --evidence or complete live arguments");
  if (result.evidence && Object.keys(result).length !== 1) throw new PolicyError("evidence and live arguments are exclusive");
  return result;
}
export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const evidence = args.evidence ? parseStrictJson(fs.readFileSync(args.evidence, "utf8"))
      : collectLive(repositorySlug(args.repository), positiveInteger(Number(args.pr), "pr"), oid(args.base, "base"), oid(args.head, "head"));
    process.stdout.write(`train-ci-receipts: ${canonical(validateEvidence(evidence))}\n`); return 0;
  } catch (error) {
    process.stderr.write(`train-ci-receipts: REFUSED: ${error.message}\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
