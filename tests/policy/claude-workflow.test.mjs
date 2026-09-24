// Safety boundaries of the comment-triggered @claude workflow.
//
// This job hands a write-capable App token and the Claude OAuth token to a
// model acting on comment text, so a few properties must not drift in a
// later edit: every action is pinned to an immutable commit, only owners,
// members, and collaborators can start a run, fork PRs are refused before
// checkout, and the workflow's own GITHUB_TOKEN carries no write scope.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "../..");
const workflow = parse(fs.readFileSync(path.join(root, ".github", "workflows", "claude.yml"), "utf8"));
const jobs = Object.values(workflow.jobs);
const steps = jobs.flatMap((job) => job.steps);
const TRUSTED = `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'),`;

test("every action is pinned to a commit", () => {
  const refs = steps.flatMap((step) => step.uses ? [step.uses] : []);
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is not pinned to a commit SHA`);
});

test("every trigger requires a trusted author", () => {
  for (const job of jobs) {
    const events = [...job.if.matchAll(/github\.event_name == '(\w+)'/g)].map((match) => match[1]);
    assert.deepEqual(events.sort(), Object.keys(workflow.on).sort());
    assert.equal(job.if.split(TRUSTED).length - 1, events.length);
  }
});

test("fork pull requests are refused before checkout", () => {
  for (const job of jobs) {
    const guard = job.steps.findIndex((step) => String(step.run ?? "").includes("isCrossRepository"));
    const checkout = job.steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    assert.ok(guard >= 0, "fork guard is missing");
    assert.ok(guard < checkout, "fork guard must run before checkout");
  }
});

test("workflow token has no write scope except OIDC", () => {
  assert.equal(workflow.permissions, undefined);
  for (const job of jobs) {
    assert.equal(typeof job.permissions, "object");
    const writes = Object.entries(job.permissions).filter(([, value]) => value === "write").map(([key]) => key);
    assert.deepEqual(writes, ["id-token"]);
  }
});
