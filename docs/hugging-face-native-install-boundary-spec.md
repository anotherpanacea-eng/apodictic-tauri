# Spec — native boundary for curated local-model installation

**Status:** future hardened multi-model boundary; not built. The Qwen-only MVP is owned by the
Gemini sidecar under `local-provider-cutover-spec.md`. Do not implement or run this broker
beside that route. A future M6 must choose one process owner and must treat the MVP llama.cpp
cache as opaque unless it explicitly revalidates and migrates it into the curated registry.
**Date:** 2026-07-21.
**Owner:** `apodictic-tauri` native shell only.
**Paired engine spec:** `APODICTIC-Gemini/docs/hugging-face-artifact-acquisition-spec.md`.

## 1. Decision

Keep Hugging Face transport, manifests, installation jobs, validation, registry, and model
provider semantics in the Gemini sidecar. Tauri supplies only the OS-native authority the
shared engine cannot safely or portably own:

1. choose/create the managed local-model root and pass it to the sidecar;
2. protect the acquisition encryption key through the existing keychain chain;
3. discover, approve, attest, launch, monitor, and stop a compatible local runtime; and
4. expose coarse native storage/runtime status without leaking paths or command lines to the
   webview.

The shell does not implement a Hugging Face client, model catalog, downloader, parser,
provider, or calibration policy. “Import into Tauri” means integrate the sidecar's verified
artifact registry with this narrow native boundary, not port the loader into Rust.

## 2. Preconditions

This increment starts only after the local/loopback runtime contract and authenticated
sidecar control channel from the cutover roadmap are implemented. Hosted/remote UI mode has
no native install surface. The sidecar and shell versions must mutually advertise the exact
`apodictic-native-model-boundary/1` capability before either exposes install controls.

## 3. Managed model root

On startup, Tauri creates an owner-only `models` child beneath the OS application-data root,
opens it without following links, records its stable OS directory identity, and passes the
canonical path plus that identity to the sidecar at launch. The sidecar rejects a missing
value in packaged local mode and owns ongoing no-follow confinement, staging/publication,
and deletion under the fixed root. It revalidates root identity before every irreversible
transition. Tauri revalidates the same identity before sandbox validation or runtime launch.
This is intentionally a fixed same-user application root, not a claim that a path string is
a transferable native capability.

Tauri never accepts a model-root path from React. A future user-selectable external volume
requires a separate picker/bookmark/reparse-point spec. V1 does not use arbitrary folders,
network shares, cloud-synced folders, removable media, or symlinked roots.

The shell may report to the webview only aggregate capacity class, free bytes, required
bytes, and a stable opaque volume id. Absolute paths, usernames, mount labels, and device
serials remain sidecar/native diagnostics and are sanitized from ordinary logs.

## 4. Parent IPC authority

The existing OS-keychain-derived `CREDENTIAL_ENCRYPTION_KEY` remains the envelope key given
to the sidecar. Hugging Face acquisition tokens use the sidecar's separate credential
purpose/table, so no new raw secret crosses the webview or command layer.

Do not add a persistent `LOCAL_CONTROL_KEY`. Runtime and validator operations reuse the
cutover M2 parent/sidecar channel: Tauri creates one per-launch secret, keeps it memory-only,
passes it through inherited IPC, and authenticates versioned, sequenced request/response
frames from the child it spawned. A domain-separated session capability for native model
operations is derived in memory from that launch secret and erased with the session. It never
enters argv, environment, HTTP, keychain, database, logs, crash reports, or React state.

## 5. Runtime profiles

Tauri ships a closed registry `apodictic-runtime-profile/1`. Each profile includes:

```text
profile_id/profile_version/definition_sha256
runtime_family
supported_os/supported_arch
discovery_rules
minimum_version/version_probe
publisher_identity_allowlist and/or explicit operator-approval policy
argv_template_id
allowed_environment_keys
health_probe_shape
shutdown_policy
resource_limits
```

V1 may implement one GGUF-capable llama.cpp-compatible profile after it passes the target-OS
smoke. Ollama/LM Studio/OpenAI-compatible user-managed endpoints remain sidecar provider
adapters and do not become shell-launched merely because they are installed. Safetensors
requires a separately reviewed compatible runtime profile before the shell can launch it.

The registry contains templates, never model paths or user commands. Changing discovery,
publisher rules, argv construction, environment, or health semantics changes the profile
hash and requires review.

## 6. Discovery and approval

Discovery searches only profile-declared canonical install locations and OS registration
mechanisms. It does not recursively search the disk or honor `PATH` in packaged mode.
Candidates are opened no-follow, required to be regular executable files outside the model
root, and inspected for canonical path, stable file identity, size, SHA-256, version output,
architecture, and platform trust:

- macOS: code-signing identity, hardened-runtime/notarization status when present;
- Windows: Authenticode identity and reparse-safe file identity; and
- Linux future: package/source identity or explicit executable hash.

A candidate matching a reviewed publisher allowlist may be approved automatically. An
unsigned or unmatched candidate is disabled by default; if a profile explicitly permits
operator approval, the native dialog shows product, canonical non-secret location, version,
publisher status, and executable hash. Approval binds that exact hash/file identity and is
stored in Stronghold. Any byte/path/version change requires approval again.

No webview-supplied executable path, URL, argv, environment name/value, working directory, or
shell string is accepted.

## 7. Internal native-operation protocol

React never invokes runtime start/stop. The TypeScript provider broker sends a closed request
over authenticated parent IPC when a selected local provider needs a runtime:

This is the same authoritative discriminated union as the paired Gemini spec. Implementations
generate both ends from one schema fixture and pin its SHA-256 in a cross-repo conformance test.

```text
common request
  schema: "apodictic-native-operation-request/1"
  launch_session_id/request_id/monotonic_sequence
  operation

operation = "validate_local_model_artifact"
  installation_id/manifest_sha256/artifact_tree_sha256
  artifact_relative_entrypoint
  artifact_entrypoint_sha256/artifact_entrypoint_size_bytes
  artifact_format: "gguf" | "safetensors"
  validator_profile_id/validator_profile_version
  validator_profile_definition_sha256
  resource_limits

operation = "ensure_local_model_runtime"
  installation_id/manifest_sha256/installation_receipt_sha256
  artifact_tree_sha256/artifact_relative_entrypoint
  artifact_entrypoint_sha256/artifact_entrypoint_size_bytes
  runtime_profile_id/runtime_profile_version
  runtime_profile_definition_sha256
  resource_limits

operation = "stop_local_model_runtime"
  installation_id/runtime_attestation_sha256/opaque_process_id

common response
  schema: "apodictic-native-operation-response/1"
  launch_session_id/request_id/monotonic_sequence/operation
  status: "ok" | "unavailable" | "refused" | "failed"
  reason

validate ok payload
  validator_attestation_sha256
  observed_entrypoint_sha256/observed_entrypoint_size_bytes
  validation_summary_sha256

ensure ok payload
  runtime_attestation_sha256/opaque_process_id
  loopback_endpoint_capability/model_identity_smoke_sha256

stop ok payload
  stopped_attestation_sha256
```

Tauri owns the canonical combined JSON Schema at
`src-tauri/schemas/apodictic-native-model-operation-v1.schema.json`. Gemini keeps a
byte-identical, hash-pinned consumer mirror at
`server/native/schemas/apodictic-native-model-operation-v1.schema.json`; the paired release
gate compares raw-file SHA-256 before packaging or integration. Generated Rust and TypeScript
types are outputs, not schema authorities.

All hashes are lowercase 64-character SHA-256 hex. `monotonic_sequence` and byte sizes are
integers from 0 through `9007199254740991`. Session, request, installation, and opaque-process
ids are 22--128 ASCII characters matching `[A-Za-z0-9_-]+`; profile ids are 1--64 lowercase
ASCII characters matching `[a-z0-9][a-z0-9._-]*`; profile versions are 1--32 ASCII characters
matching `[A-Za-z0-9][A-Za-z0-9._-]*`. The schema sets `additionalProperties=false` at every
object.

The validation-operation `resource_limits` object has exactly these required integer fields
and inclusive V1 ranges:

```text
wall_time_ms                 1..600000
cpu_time_ms                  1..600000
resident_memory_bytes        1048576..68719476736
open_file_count              3..256
process_count                1..4
captured_output_bytes        1..1048576
```

The ensure-runtime `resource_limits` object has exactly:

```text
startup_deadline_ms          1..600000
shutdown_deadline_ms         1..120000
resident_memory_bytes        268435456..274877906944
open_file_count              3..4096
process_count                1..64
thread_count                 1..4096
captured_output_bytes        1..16777216
```

The signed validator/runtime profile contains a maximum for every corresponding limit and, for
startup/shutdown, any required minimum deadline. The sidecar request may only be equal or
stricter: no numeric resource ceiling may exceed the profile maximum, and a deadline may not
fall below its required minimum. Rust re-derives the intersection and refuses a missing field,
out-of-range value, weakened profile, or mismatch; it never substitutes a more permissive
value. Stop has no `resource_limits`. Unknown or cross-operation fields refuse. A response
must match the exact session, request, sequence, operation, and discriminant of its pending
request; non-`ok` responses contain no success payload.

The request contains a relative artifact entrypoint, never an executable or arbitrary argv.
Rust verifies channel session/sequence/request identity, profile identity, installation
receipt, current model-root identity/confinement, regular-file identity, expected artifact
hash/size, and current free resources. It then expands the profile's fixed argv template. A
planted child frame cannot escape the model root, select another executable, add an option,
or weaken a limit.

Responses use the closed union above. Replays, gaps, unsolicited responses, prior-launch frames,
or cross-installation responses refuse. This protocol is not HTTP and is absent from public
OpenAPI/MCP/actions surfaces.

For `validate_local_model_artifact`, Rust launches the pinned validator from the signed
desktop payload in an OS sandbox with read-only access to the one declared artifact tree, no
network, empty isolated cwd, scrubbed environment, and mechanical memory/CPU/file/output
limits. An ordinary Node worker is not sufficient. Sandbox unavailability is a refusal.

## 8. Process lifecycle

An eligible runtime profile must support one of two race-free listener mechanisms: (A) Rust
creates and retains a pre-bound loopback listener and the child inherits its exact descriptor/
handle, or (B) the child binds port zero itself, reports the resulting endpoint over the
inherited authenticated control stream, and Rust verifies through the OS that the listener is
owned by that exact child process or process group before issuing any endpoint capability.
Rust never closes a reservation and asks the child to rebind the same numeric port. A profile
supporting neither mechanism is `runtime_unavailable`. A conventional listen-only health
check is not endpoint-ownership proof. Non-loopback, wildcard, Unix-socket escape, inherited
proxy configuration, or remote-control flags are prohibited.
The runtime receives only the profile-allowed environment and a sanitized working directory;
provider/acquisition credentials and manuscript text are never environment variables.

Rust retains the child handle and records aggregate state:

```text
starting -> health_checking -> ready -> stopping -> stopped
                         \-> failed
```

Readiness requires verified listener ownership, the profile health probe, and a sidecar
model-identity smoke; listening on
a port alone is insufficient. The endpoint capability and attestation return over parent IPC
and are never editable in React. Unexpected exit, health drift,
installation byte drift, sleep/wake failure, or profile mismatch removes readiness and causes
the sidecar provider to abstain. There is no cloud fallback.

Shutdown is graceful with a bounded deadline, then process-group termination. Tauri closes
the child on app exit, upgrade, installation deletion, and sidecar incompatibility. It must
not terminate an independently user-managed runtime.

## 9. Native commands and client surface

Closed commands:

```text
get_local_model_native_status()
list_local_runtime_candidates()
approve_local_runtime_candidate(candidate_id, expected_sha256)
revoke_local_runtime_approval(approval_id)
```

Responses contain ids, hashes, runtime family/version, readiness reason, and aggregate
resource numbers. No response contains tokens, raw native-operation frames, absolute model paths,
full executable command lines, environment, or control-channel secrets.

Capabilities grant these commands only to the packaged local APODICTIC window. Remote pages,
navigation away from the authenticated local origin, dev-server content outside explicit dev
mode, and additional windows receive no local-model command authority.

## 10. Non-goals

- Downloading from Hugging Face in Rust.
- Bundling or auto-updating llama.cpp/Ollama/LM Studio.
- Executing model-repository code, conversion scripts, Python, shells, or plugins.
- Letting the user paste runtime flags or choose arbitrary executables/folders.
- Treating a runtime signature or successful launch as model calibration.
- Giving hosted APODICTIC access to desktop installations.

## 11. Delivery increments

1. Capability/version negotiation, owner-only model root/identity, domain-separated
   per-launch parent-IPC capability, and tests.
2. Closed runtime-profile registry plus model-free path/argv/frame validation tests.
3. Target-OS discovery, trust inspection, Stronghold approval/revocation, and adversarial
   candidate fixtures.
4. Authenticated parent-IPC operation integration with the Gemini sidecar, including the
   native-sandboxed artifact validator.
5. One reviewed GGUF runtime profile, process lifecycle, health/model smoke, sleep/wake/exit
   recovery, and a packaged-app test.
6. UI integration after native and sidecar reviews are clear.

Each code increment follows spec -> independent spec review -> build -> independent
implementation review -> PR. The paired Gemini increment must be pinned by commit in the PR
description; neither repo may claim end-to-end readiness alone.

## 12. Acceptance

1. Hosted mode, incompatible sidecar capability, untrusted origin/window, arbitrary root,
   missing/stale parent-IPC session, or unknown installation/profile refuses before discovery
   or spawn.
2. Model-root creation and every operation-frame path test cover symlink/reparse swaps, parent/drive/
   UNC/ADS syntax, case/confusable collisions, special files, and replacement-after-check.
3. Discovery refuses `PATH`, recursive search, model-root executables, wrong architecture,
   mutable candidates, publisher mismatch, and stale approval; approval binds exact bytes.
4. Launch-session/sequence/request/install-receipt/tree/profile/resource mutation refuses. A
   replayed, unsolicited, prior-launch, or cross-installation frame cannot validate or start.
5. Argv/environment/working-directory golden tests prove no webview/sidecar text becomes a
   command, executable, option name, environment key, or shell expansion.
6. The runtime binds loopback only. Hostile pre-bound listeners, reservation-release takeover,
   forged readiness, wrong owning PID/process group, and child port substitution cannot produce
   an endpoint capability. Wrong model identity, unhealthy endpoint, crash, byte drift, and
   sleep/wake failure revoke sidecar readiness and never trigger cloud fallback.
7. App exit and deletion stop only Tauri-owned children within bounded time; independently
   managed endpoints are never killed.
8. Logs and command responses contain no acquisition token, launch secret/session capability,
   model path, username,
   manuscript text, signed URL, or full argv.
9. Static ownership guards fail if Hugging Face transport/catalog/provider logic enters Rust,
   if Node bypasses parent IPC with `child_process`, or if React gains direct file/process/
   token/runtime-start APIs.
