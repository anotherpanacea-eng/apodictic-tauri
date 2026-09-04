#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadInventory, verifyTrain } from "./check-merge-train.mjs";
import { collectLive, validateEvidence } from "./check-train-ci-receipts.mjs";
import {
  PolicyError, REMOTE_URL, REPOSITORY, SYNC_REF, TRAIN_RE, boundedDecimal, canonical, exactKeys,
  git, gitResult, oid, parseStrictJson, positiveInteger, repositorySlug,
  refuseObjectRewrites, resolveCommit, safeGitEnvironment, same,
} from "./train-policy-common.mjs";

function raw(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new PolicyError(`${command} ${args.join(" ")} failed`);
  return String(result.stdout);
}
function ghJson(gh, args) { return JSON.parse(raw(gh, args)); }
function absoluteGhRunner(gh) {
  const execute = (command) => {
    if (!Array.isArray(command) || command[0] !== "gh") throw new PolicyError("live receipt runner accepted only gh");
    return raw(gh, command.slice(1));
  };
  return { run: execute, json: (command) => JSON.parse(execute(command)) };
}

export function assertCanonicalRemote(value) {
  if (value !== REMOTE_URL) throw new PolicyError("remote URL is not the canonical GitHub HTTPS repository");
  return value;
}

export function resolveGhExecutable() {
  const locator = process.platform === "win32" ? ["where.exe", ["gh"]] : ["sh", ["-c", "command -v gh"]];
  const candidate = raw(locator[0], locator[1]).split(/\r?\n/).find(Boolean);
  if (!candidate || !path.isAbsolute(candidate)) throw new PolicyError("gh did not resolve to an absolute executable");
  const resolved = fs.realpathSync(candidate);
  if (!fs.statSync(resolved).isFile()) throw new PolicyError("gh is not a regular executable");
  raw(resolved, ["auth", "status", "--hostname", "github.com"], { stdio: ["ignore", "ignore", "ignore"] });
  return resolved;
}

export function createControlledBare(parent = os.tmpdir()) {
  const directory = fs.mkdtempSync(path.join(parent, "tauri-landing-"));
  const init = spawnSync("git", ["init", "--bare", directory], { env: safeGitEnvironment(), encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new PolicyError("cannot initialize controlled transport");
  const keys = String(git(directory, ["config", "--local", "--name-only", "--get-regexp", ".*"])).trim().split(/\r?\n/).filter(Boolean);
  const allowed = new Set([
    "core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates",
    "core.symlinks", "core.ignorecase", "extensions.objectformat",
  ]);
  if (keys.some((key) => !allowed.has(key))) throw new PolicyError("controlled transport has unexpected local config");
  return directory;
}

export function transportGit(directory, gh, args, options = {}) {
  if (!path.isAbsolute(gh) || !fs.statSync(gh).isFile()) throw new PolicyError("gh helper must be an absolute regular executable");
  if (options.gitExecPath !== undefined && (!path.isAbsolute(options.gitExecPath) || !fs.statSync(options.gitExecPath).isDirectory())) throw new PolicyError("Git exec path must be an absolute directory");
  const helper = `!\"${gh.replaceAll("\\", "/")}\" auth git-credential`;
  const result = spawnSync("git", [
    ...(options.gitExecPath ? [`--exec-path=${options.gitExecPath}`] : []),
    "--no-replace-objects", "-c", "credential.helper=",
    "-c", `credential.https://github.com.helper=${helper}`,
    "-C", directory, ...args,
  ], { env: safeGitEnvironment(), encoding: "utf8", input: options.input, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new PolicyError(`controlled git ${args[0]} failed`);
  return String(result.stdout);
}

export function verifySynthetic(directory, { base, head, synthetic, authorization }) {
  for (const [name, value] of Object.entries({ base, head, synthetic })) oid(value, name);
  refuseObjectRewrites(directory);
  const fetchedBase = String(git(directory, ["rev-parse", "--verify", "refs/landing/base^{commit}"])).trim();
  const fetchedSynthetic = String(git(directory, ["rev-parse", "--verify", "refs/landing/synthetic^{commit}"])).trim();
  if (fetchedBase !== base || fetchedSynthetic !== synthetic) throw new PolicyError("fetched landing objects disagree with receipt");
  if (resolveCommit(directory, head, "head") !== head) throw new PolicyError("fetched synthetic merge omits exact head object");
  const fields = String(git(directory, ["rev-list", "--parents", "-n", "1", synthetic])).trim().split(/\s+/);
  if (fields.length !== 3 || fields[1] !== base || fields[2] !== head) throw new PolicyError("synthetic merge parents are not exact BASE,HEAD");
  if (authorization === "train") {
    const syntheticTree = String(git(directory, ["rev-parse", `${synthetic}^{tree}`])).trim();
    const headTree = String(git(directory, ["rev-parse", `${head}^{tree}`])).trim();
    if (syntheticTree !== headTree) throw new PolicyError("train synthetic tree differs from frozen train head");
  } else if (authorization !== "standalone") throw new PolicyError("unknown landing authorization");
  return synthetic;
}

function validateClearance(value) {
  exactKeys(value, ["schema", "authorization", "repository", "pr", "base_ref", "base_sha", "head_sha", "workflow_path", "run_id", "run_attempt", "job_count", "synthetic_merge_sha"], "clearance");
  if (value.schema !== "apodictic-tauri-train-ci-clearance/1" || value.base_ref !== "main" || value.workflow_path !== ".github/workflows/ci.yml" || value.job_count !== 1) throw new PolicyError("clearance contract is wrong");
  repositorySlug(value.repository); positiveInteger(value.pr, "pr");
  boundedDecimal(value.run_id, "run_id", 9_223_372_036_854_775_807n);
  boundedDecimal(value.run_attempt, "run_attempt", 999_999n);
  oid(value.base_sha, "base_sha"); oid(value.head_sha, "head_sha"); oid(value.synthetic_merge_sha, "synthetic_merge_sha");
  if (!["train", "standalone"].includes(value.authorization)) throw new PolicyError("clearance authorization is wrong");
  return value;
}

function branchItem(headRepo, headRef, expectedSha) { return { head_ref: headRef, head_repo: headRepo, expected_sha: expectedSha }; }
function preserved(headRepo, headRef, expectedSha, reason) { return { ...branchItem(headRepo, headRef, expectedSha), reason }; }

export function classifyCleanup({ repository, headRepo, headRef, expectedSha, remoteSha }) {
  oid(expectedSha, "expected branch sha");
  if (!same(repository, headRepo)) return { delete: false, item: preserved(headRepo, headRef, expectedSha, "fork") };
  if (remoteSha === null) return { delete: false, item: preserved(headRepo, headRef, expectedSha, "already-absent") };
  oid(remoteSha, "remote branch sha");
  if (remoteSha !== expectedSha) return { delete: false, item: preserved(headRepo, headRef, expectedSha, "advanced") };
  return { delete: true, item: branchItem(headRepo, headRef, expectedSha) };
}

export function classifyConstituentState({ repository, baseSha, step, pull }) {
  const unchanged = same(pull?.head?.repo?.full_name, step.head_repo)
    && same(pull?.head?.ref, step.head_ref)
    && pull?.head?.sha === step.head
    && pull?.state === "open"
    && pull?.merged === false
    && same(pull?.base?.ref, "main")
    && pull?.base?.sha === baseSha;
  return {
    unchanged,
    preserveReason: !same(step.head_repo, repository) ? "fork" : (unchanged ? null : "advanced"),
  };
}

export function classifyPostLandingPull({ repository, headRepo, headRef, headSha, pull }) {
  const external = !same(headRepo, repository);
  const identity = same(pull?.head?.repo?.full_name, headRepo)
    && same(pull?.head?.ref, headRef)
    && pull?.head?.sha === headSha;
  if (!identity) return external ? "fork" : "advanced";
  if (pull?.state !== "closed" || pull?.merged !== true) return "delete-refused";
  return external ? "fork" : null;
}

export function validateLandingAuthorization({ authorization, headRepo, headRef, labels, inventoryPath }) {
  const names = Array.isArray(labels) ? labels : [];
  if (authorization === "train") {
    if (!same(headRepo, REPOSITORY) || !TRAIN_RE.test(headRef) || !inventoryPath) throw new PolicyError("train landing identity/inventory is wrong");
    return "train";
  }
  if (authorization !== "standalone"
    || (same(headRepo, REPOSITORY) && same(headRef, SYNC_REF))
    || !names.some((label) => same(label, "ci-ready"))
    || inventoryPath) throw new PolicyError("standalone authorization is stale");
  return "standalone";
}

export function validateLiveLandingPull(pull, clearance) {
  if (pull?.state !== "open" || pull.merged !== false || pull.draft !== false
    || pull.base?.ref !== "main" || pull.base?.sha !== clearance.base_sha
    || pull.head?.sha !== clearance.head_sha) throw new PolicyError("live PR identity/state changed after clearance");
  return pull;
}

function openPullIds(value, where) {
  if (!Array.isArray(value) || value.length >= 100) throw new PolicyError(`${where} open-PR inventory is unavailable or truncated`);
  return new Set(value.map((pull) => positiveInteger(pull?.number, `${where} open PR`)));
}

export function convergePostLandingPull({ apiJson, item, wait, attempts = 31 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let pull = null; let available = true;
    try { pull = apiJson(["api", `repos/${REPOSITORY}/pulls/${item.pr}`]); } catch { available = false; }
    if (available) {
      const reason = classifyPostLandingPull({
        repository: REPOSITORY, headRepo: item.head_repo, headRef: item.head_ref,
        headSha: item.head_sha, pull,
      });
      if (reason !== "delete-refused") return reason;
    }
    if (attempt + 1 < attempts) wait(1000);
  }
  return "delete-refused";
}

export function verifyPostLandingRepository(apiJson, beforeIds, requiredClosed, synthetic, wait = () => {}) {
  const after = openPullIds(apiJson(["api", `repos/${REPOSITORY}/pulls?state=open&per_page=100`]), "post-landing");
  for (const id of after) if (!beforeIds.has(id)) throw new PolicyError(`unexpected open PR ${id} appeared during landing`);
  for (const id of requiredClosed) if (after.has(id)) throw new PolicyError(`landed PR ${id} remains open after bounded convergence`);
  for (let check = 0; check < 3; check += 1) {
    const runs = apiJson(["api", `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=push&head_sha=${synthetic}&per_page=100`]);
    if (!Array.isArray(runs?.workflow_runs) || runs.workflow_runs.length !== 0) throw new PolicyError("post-landing ci.yml push run exists or could not be disproved");
    if (check < 2) wait(2000);
  }
  return { open_prs: [...after].sort((a, b) => a - b), post_main_ci_runs: 0 };
}

function liveRef(directory, gh, ref) {
  const output = transportGit(directory, gh, ["ls-remote", "--heads", REMOTE_URL, `refs/heads/${ref}`]).trim();
  if (!output) return null;
  const fields = output.split(/\s+/); if (fields.length !== 2 || fields[1] !== `refs/heads/${ref}`) throw new PolicyError("remote ref lookup is ambiguous");
  return oid(fields[0], "remote ref");
}
export function cleanupBranch(directory, gh, repository, headRepo, headRef, expectedSha, operations = {}) {
  const readRef = operations.liveRef ?? liveRef;
  const push = operations.transportGit ?? transportGit;
  const state = classifyCleanup({ repository, headRepo, headRef, expectedSha, remoteSha: same(repository, headRepo) ? readRef(directory, gh, headRef) : null });
  if (!state.delete) return { deleted: null, preserved: state.item };
  try {
    push(directory, gh, ["push", `--force-with-lease=refs/heads/${headRef}:${expectedSha}`, REMOTE_URL, `:refs/heads/${headRef}`]);
    return { deleted: state.item, preserved: null };
  } catch {
    return { deleted: null, preserved: preserved(headRepo, headRef, expectedSha, "delete-refused") };
  }
}

export function validateReviewGate({ body, head, reviewDecision, reviewThreads }) {
  oid(head, "review head");
  if (typeof body !== "string") throw new PolicyError("PR body is unavailable for exact-head review receipts");
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const field = "- **Exact-head generic / fleet-posture / CI reviews:**";
  const fields = lines.flatMap((line, index) => line.trim() === field ? [index] : []);
  if (fields.length !== 1) throw new PolicyError("exact-head review receipt field is missing or duplicated");
  const section = [];
  for (let index = fields[0] + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^(?:#{1,6}\s|[-*+] \*\*)/.test(trimmed)) break;
    section.push(lines[index]);
  }
  const stripInlineCode = (value) => {
    let visible = ""; let index = 0;
    while (index < value.length) {
      if (value[index] !== "`") { visible += value[index]; index += 1; continue; }
      let end = index + 1; while (value[end] === "`") end += 1;
      const delimiter = value.slice(index, end); const closing = value.indexOf(delimiter, end);
      if (closing < 0) { visible += value.slice(index); break; }
      index = closing + delimiter.length;
    }
    return visible;
  };
  const matches = []; let fence = null; let commentBlock = false;
  for (const line of section) {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (opening && opening[1][0] === fence.char && opening[1].length >= fence.width && /^\s*$/.test(opening[2])) fence = null;
      continue;
    }
    if (opening) { fence = { char: opening[1][0], width: opening[1].length }; continue; }
    if (/^(?: {4,}|\t)/.test(line)) continue;
    const exact = line.match(/^ {0,3}<!-- apodictic-exact-head-review (\{[^\r\n]*\}) -->[ \t]*$/);
    if (exact && !commentBlock) { matches.push(exact); continue; }
    const visible = stripInlineCode(line);
    if (commentBlock) { if (visible.includes("-->")) commentBlock = false; continue; }
    if (visible.includes("<!--") && !visible.includes("-->")) { commentBlock = true; continue; }
    if (visible.includes("apodictic-exact-head-review")) throw new PolicyError("malformed exact-head review receipt envelope");
  }
  const lanes = new Set();
  for (const match of matches) {
    const receipt = parseStrictJson(match[1]);
    exactKeys(receipt, ["schema", "lane", "head_sha", "verdict"], "review receipt");
    if (receipt.schema !== "apodictic-tauri-exact-head-review/1" || receipt.head_sha !== head || receipt.verdict !== "approved") throw new PolicyError("review receipt is stale or malformed");
    if (!["generic", "fleet-posture", "ci"].includes(receipt.lane) || lanes.has(receipt.lane)) throw new PolicyError("review receipt lane is unknown or duplicated");
    lanes.add(receipt.lane);
  }
  for (const lane of ["generic", "fleet-posture", "ci"]) if (!lanes.has(lane)) throw new PolicyError(`missing exact-head ${lane} review receipt`);
  if (reviewDecision === "CHANGES_REQUESTED") throw new PolicyError("review gate has requested changes");
  if (!reviewThreads || reviewThreads.pageInfo?.hasNextPage || !Array.isArray(reviewThreads.nodes) || reviewThreads.nodes.some((item) => !item.isResolved)) throw new PolicyError("review gate has unresolved or unbounded threads");
  return { head_sha: head, lanes: [...lanes].sort() };
}

function assertReviewGate(gh, repository, pr, body, head) {
  const [owner, name] = repository.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}";
  const data = ghJson(gh, ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`]);
  const pull = data?.data?.repository?.pullRequest;
  if (!pull) throw new PolicyError("review gate is unavailable");
  return validateReviewGate({ body, head, reviewDecision: pull.reviewDecision, reviewThreads: pull.reviewThreads });
}

export function landReviewed({ clearance, inventoryPath = null, repo = process.cwd(), gh = resolveGhExecutable(), dependencies = {} }) {
  validateClearance(clearance);
  const apiJson = dependencies.ghJson ?? ((args) => ghJson(gh, args));
  const collectEvidence = dependencies.collectLive ?? ((repository, pr, base, head) => collectLive(repository, pr, base, head, absoluteGhRunner(gh)));
  const reviewGate = dependencies.assertReviewGate ?? ((repository, pr, body, head) => assertReviewGate(gh, repository, pr, body, head));
  const makeTransport = dependencies.createControlledBare ?? createControlledBare;
  const controlledGit = dependencies.transportGit ?? ((directory, args) => transportGit(directory, gh, args));
  const readRef = dependencies.liveRef ?? ((directory, ref) => liveRef(directory, gh, ref));
  const cleanBranch = dependencies.cleanupBranch ?? ((directory, repository, candidateRepo, candidateRef, expected) => cleanupBranch(directory, gh, repository, candidateRepo, candidateRef, expected));
  const wait = dependencies.wait ?? ((milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds));
  if (!same(clearance.repository, REPOSITORY)) throw new PolicyError("landing repository is not canonical");
  const pull = apiJson(["api", `repos/${REPOSITORY}/pulls/${clearance.pr}`]);
  const openBefore = openPullIds(apiJson(["api", `repos/${REPOSITORY}/pulls?state=open&per_page=100`]), "pre-landing");
  if (!openBefore.has(clearance.pr)) throw new PolicyError("landing PR is absent from open-PR inventory");
  validateLiveLandingPull(pull, clearance);
  const headRepo = pull.head?.repo?.full_name; const headRef = pull.head?.ref;
  const labels = (pull.labels ?? []).map((item) => item.name);
  validateLandingAuthorization({ authorization: clearance.authorization, headRepo, headRef, labels, inventoryPath });
  const liveClearance = validateEvidence(collectEvidence(REPOSITORY, clearance.pr, clearance.base_sha, clearance.head_sha));
  if (canonical(liveClearance) !== canonical(clearance)) throw new PolicyError("live CI clearance changed before landing");
  reviewGate(REPOSITORY, clearance.pr, pull.body, clearance.head_sha);

  let inventory = null; const constituentHeads = []; const prePreserved = []; const requiredClosed = new Set([clearance.pr]);
  if (clearance.authorization === "train") {
    inventory = loadInventory(inventoryPath); verifyTrain(repo, inventory);
    if (inventory.base !== clearance.base_sha || inventory.head !== clearance.head_sha) throw new PolicyError("inventory endpoints disagree with clearance");
    for (const step of inventory.steps.filter((item) => item.kind === "constituent")) {
      constituentHeads.push({ pr: step.pr, head_repo: step.head_repo, head_ref: step.head_ref, head_sha: step.head });
      const current = apiJson(["api", `repos/${REPOSITORY}/pulls/${step.pr}`]);
      const state = classifyConstituentState({ repository: REPOSITORY, baseSha: clearance.base_sha, step, pull: current });
      if (state.unchanged && (current.draft !== true || (current.labels ?? []).some((label) => same(label.name, "ci-ready")))) throw new PolicyError(`constituent ${step.pr} is armed`);
      if (state.unchanged) requiredClosed.add(step.pr);
      if (state.preserveReason) prePreserved.push(preserved(step.head_repo, step.head_ref, step.head, state.preserveReason));
    }
  }

  assertCanonicalRemote(String(git(repo, ["remote", "get-url", "origin"])).trim());
  const transport = makeTransport();
  const deleted = []; const kept = [...prePreserved];
  try {
    controlledGit(transport, ["fetch", "--no-tags", "--no-write-fetch-head", REMOTE_URL,
      `refs/heads/main:refs/landing/base`, `refs/pull/${clearance.pr}/merge:refs/landing/synthetic`]);
    verifySynthetic(transport, { base: clearance.base_sha, head: clearance.head_sha, synthetic: clearance.synthetic_merge_sha, authorization: clearance.authorization });
    if (readRef(transport, "main") !== clearance.base_sha) throw new PolicyError("main advanced before CAS");
    controlledGit(transport, ["push", `--force-with-lease=refs/heads/main:${clearance.base_sha}`, REMOTE_URL, `${clearance.synthetic_merge_sha}:refs/heads/main`]);
    if (readRef(transport, "main") !== clearance.synthetic_merge_sha) throw new PolicyError("main CAS readback failed");
    for (const item of constituentHeads) {
      const contained = gitResult(transport, ["merge-base", "--is-ancestor", item.head_sha, clearance.synthetic_merge_sha]);
      if (contained.status !== 0) throw new PolicyError(`constituent ${item.pr} is not contained in main`);
    }
    const candidates = clearance.authorization === "train" ? [...constituentHeads, { pr: clearance.pr, head_repo: headRepo, head_ref: headRef, head_sha: clearance.head_sha }]
      : [{ pr: clearance.pr, head_repo: headRepo, head_ref: headRef, head_sha: clearance.head_sha }];
    const already = new Set(kept.map((item) => `${item.head_repo.toLowerCase()}\0${item.head_ref.toLowerCase()}`));
    for (const item of candidates) {
      const key = `${item.head_repo.toLowerCase()}\0${item.head_ref.toLowerCase()}`;
      const closureReason = convergePostLandingPull({ apiJson, item, wait });
      if (already.has(key)) continue;
      if (closureReason) {
        kept.push(preserved(item.head_repo, item.head_ref, item.head_sha, closureReason));
        already.add(key);
        continue;
      }
      const outcome = cleanBranch(transport, REPOSITORY, item.head_repo, item.head_ref, item.head_sha);
      if (outcome.deleted) deleted.push(outcome.deleted); if (outcome.preserved) kept.push(outcome.preserved);
      already.add(key);
    }
    const receipt = {
      authorization: clearance.authorization, base_sha: clearance.base_sha,
      constituent_heads: constituentHeads, deleted_branches: deleted,
      head_sha: clearance.head_sha, main_sha: clearance.synthetic_merge_sha,
      pr: clearance.pr, preserved_branches: kept, repository: REPOSITORY,
      schema: "apodictic-tauri-landing/1", synthetic_merge_sha: clearance.synthetic_merge_sha,
    };
    try { verifyPostLandingRepository(apiJson, openBefore, requiredClosed, clearance.synthetic_merge_sha, wait); }
    catch (error) { error.landingReceipt = receipt; throw error; }
    return receipt;
  } finally { fs.rmSync(transport, { recursive: true, force: true }); }
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { "--clearance": "clearance", "--inventory": "inventory", "--repo": "repo" }[argv[i]];
    if (!key || result[key] !== undefined || argv[i + 1] === undefined) throw new PolicyError("invalid landing arguments"); result[key] = argv[i + 1];
  }
  if (!result.clearance) throw new PolicyError("--clearance is required"); return result;
}
export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv); const clearance = parseStrictJson(fs.readFileSync(args.clearance, "utf8"));
    process.stdout.write(`landing: ${canonical(landReviewed({ clearance, inventoryPath: args.inventory ?? null, repo: args.repo ?? process.cwd() }))}\n`); return 0;
  } catch (error) {
    if (error.landingReceipt) process.stdout.write(`landing-incomplete: ${canonical(error.landingReceipt)}\n`);
    process.stderr.write(`landing: REFUSED: ${error.message}\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
