import { REPOSITORY, SYNC_REF, TRAIN_PREFIX_RE, TRAIN_RE, same } from "./train-policy-common.mjs";

export const EVENTS = Object.freeze([
  "opened", "synchronize", "reopened", "ready_for_review",
  "converted_to_draft", "labeled", "unlabeled", "closed",
]);
const ARMABLE = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const expression = (value) => `\${{ ${value} }}`;

export const WORKFLOW_POLICY = Object.freeze({
  runName: `apodictic-tauri-ci pr=${expression("github.event.pull_request.number")} action=${expression("github.event.action")} train=${expression("github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.head.ref, 'train/')")} ci-ready-event=${expression("github.event.label.name == 'ci-ready'")}`,
  concurrencyGroup: `apodictic-tauri-ci-${expression("github.event.pull_request.number")}-${expression(`(contains(fromJSON('["opened","synchronize","reopened","ready_for_review","converted_to_draft","closed"]'), github.event.action) || (github.event.pull_request.head.repo.full_name == github.repository && !startsWith(github.event.pull_request.head.ref, 'train/') && contains(fromJSON('["labeled","unlabeled"]'), github.event.action) && github.event.label.name == 'ci-ready')) && 'clearance' || github.run_id`)}`,
  jobIf: expression(`github.event.pull_request.draft == false && ((github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.head.ref, 'train/') && contains(fromJSON('["opened","synchronize","reopened","ready_for_review"]'), github.event.action)) || (github.event.pull_request.head.repo.full_name == github.repository && !startsWith(github.event.pull_request.head.ref, 'train/') && github.event.pull_request.head.ref != 'chore/sync-gemini-web' && contains(github.event.pull_request.labels.*.name, 'ci-ready') && (contains(fromJSON('["opened","synchronize","reopened","ready_for_review"]'), github.event.action) || (github.event.action == 'labeled' && github.event.label.name == 'ci-ready'))))`),
});

export function classifyPullRequest(input) {
  const repository = input.repository ?? REPOSITORY;
  const headRepo = String(input.headRepo ?? "");
  const headRef = String(input.headRef ?? "");
  const action = String(input.action ?? "");
  const eventLabel = typeof input.eventLabel === "string" ? input.eventLabel : "";
  const labels = Array.isArray(input.labels) ? input.labels.filter((item) => typeof item === "string") : [];
  const sameRepo = same(headRepo, repository);
  const train = sameRepo && TRAIN_PREFIX_RE.test(headRef);
  const validTrain = train && TRAIN_RE.test(headRef);
  const sync = sameRepo && same(headRef, SYNC_REF);
  const hasCiReady = labels.some((label) => same(label, "ci-ready"));
  const ciReadyEvent = same(eventLabel, "ci-ready") && ["labeled", "unlabeled"].includes(action);
  const armable = ARMABLE.has(action);
  const standalone = sameRepo && !train && !sync;
  const billable = input.draft === false && (
    (train && armable)
    || (standalone && hasCiReady && (armable || (action === "labeled" && ciReadyEvent)))
  );
  const authorized = billable && (!train || validTrain);

  const labelEvent = action === "labeled" || action === "unlabeled";
  const canonical = ARMABLE.has(action)
    || action === "converted_to_draft"
    || action === "closed"
    || (standalone && labelEvent && ciReadyEvent);
  const noise = labelEvent && !canonical;
  return Object.freeze({
    action, authorized, billable, canonical, ciReadyEvent, hasCiReady, noise,
    sameRepo, standalone, sync, train, validTrain,
  });
}

export function concurrencyGroup(input) {
  const state = classifyPullRequest(input);
  const pr = Number(input.pr);
  const runId = String(input.runId ?? "unknown");
  return state.canonical ? `apodictic-tauri-ci-${pr}-clearance` : `apodictic-tauri-ci-${pr}-${runId}`;
}

export function runName(input) {
  const state = classifyPullRequest(input);
  return `apodictic-tauri-ci pr=${Number(input.pr)} action=${state.action} train=${state.train} ci-ready-event=${state.ciReadyEvent}`;
}
