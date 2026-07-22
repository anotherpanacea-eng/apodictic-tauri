# Spec — Apple Intelligence native bridge feasibility spike

**Status:** synthetic/public-data spike only; not a production provider.
**Date:** 2026-07-21.
**Owner:** `apodictic-tauri` native execution boundary.
**Paired engine contract:** `APODICTIC-Gemini/docs/apple-intelligence-provider-spike-spec.md`.

## Decision

Prototype Apple Intelligence through Apple's Foundation Models framework in a signed native
helper embedded in the Tauri product. The Gemini sidecar owns provider selection, prompts,
budgets, receipts, validation, calibration, and abstention. Tauri owns only SDK availability,
native session invocation, streaming/cancellation, and OS-process/privacy enforcement.

Do not route this through the Hugging Face installer or pretend it is an OpenAI-compatible
runtime. Do not expose a general `invoke_native_model(prompt)` webview command.

## Native shape

The implementation spike may use a small Swift executable/framework linked against the exact
Foundation Models SDK and bundled, signed, and notarized with APODICTIC. Rust launches or
calls it only through a closed bridge generated for these operations:

```text
apple_model_capabilities
apple_model_respond
apple_model_cancel
```

The TypeScript provider broker initiates requests over the authenticated, per-launch parent
IPC. Rust validates the frame and forwards only the closed bounded payload to the Swift
bridge. React has no command authority and never receives the native transcript, raw
capability object, or bridge diagnostics.

## Availability and identity

Before any prompt transfer, the bridge reports the exact SDK/bridge version, OS build,
`SystemLanguageModel.Availability` result/reason, context size when exposed, model-generation
identifier when exposed, an explicit model-revision-observability status, and locale support.
Unavailable reasons remain distinct—device ineligible, Apple Intelligence disabled,
model not ready, unsupported locale/region, or unknown future reason—and are passed to the
sidecar without being collapsed into a generic failure.

Apple updates the system model with OS releases. The bridge therefore never claims a fixed
weight hash or immutable model revision. If the exact SDK exposes a model-generation id, the
attestation records it; otherwise it records `null` and observability `unavailable`. The
attestation binds OS build, SDK/bridge build, prompt-profile identity supplied by the sidecar,
observed capabilities, a frozen behavioral-canary result, and one request id. A silent
same-build update remains undetectable when generation identity is unavailable and must be
stated as a calibration limitation.

## Session and privacy contract

- Create a fresh `LanguageModelSession` per APODICTIC pass in V1.
- Do not serialize or export the framework transcript.
- Do not call feedback-attachment submission APIs.
- Disable tools/dynamic tool calling and accept no native callback/tool definitions.
- Transfer text only over inherited authenticated IPC and in-process/native calls; no socket,
  HTTP, environment, argv, pasteboard, temporary plaintext file, analytics, or crash log.
- Bound instructions, prompt, output, stream events, deadline, and concurrent sessions before
  native invocation.
- Erase bridge/session references after completion/cancellation; receipts contain hashes and
  aggregates only.

The spike records whether OS/framework diagnostics themselves persist content and what the
signed production build can disable. Any unresolved content persistence or feedback path is
a stop condition for private-manuscript use.

## Generation and cancellation

V1 permits only literal `generation_mode="sdk_default_v1"`, applies no SDK sampling,
temperature, or other `GenerationOptions` override, and enables no tools. Output and deadline
ceilings remain external bridge limits. Unknown generation fields refuse. The bridge streams
bounded deltas tagged by request id and sequence. Rust/sidecar enforce output ceilings even if
the framework does not. Cancellation has a bounded acknowledgment; late deltas are discarded
and cannot attach to a later request. Context-size and guardrail errors are typed, sanitized,
and returned without prompt fragments.

An availability-only probe may return `context_capacity_unknown`. Generation refuses before
prompt transfer when the exact SDK does not expose, and the spike has not independently
verified, a conservative context bound. The spike may promote beyond availability-only only
after that bound is exact for the supported SDK tuple; it never guesses from observed success.

Guided generation may be tested with fixed synthetic Swift `Generable` schemas, but the
sidecar still validates the resulting canonical APODICTIC JSON. A native guided-generation
success is not an artifact acceptance bypass.

## Spike matrix

1. Compile/link/sign on the exact supported macOS/Xcode/SDK tuple.
2. Availability-only matrix: eligible, disabled, model-not-ready, unsupported locale, and
   unknown-future enum handling.
3. Synthetic response, streaming order, cancellation, timeout, output cap, context overflow,
   and guardrail refusal.
4. Transcript/feedback/tool static guards and runtime canary tests.
5. Parent-IPC replay/session/sequence/request substitution and post-cancel late-event tests.
6. OS update simulation proves capability/calibration invalidation.

## Acceptance

1. No manuscript bytes cross the native boundary until availability, locale, context budget,
   IPC session, prompt profile, and request ceilings pass.
2. Unsupported/unavailable states do not spawn a helper or fall back to another provider.
3. The helper is bundled/signed; no user path, `PATH`, downloaded binary, plugin, script,
   model file, or arbitrary Swift type is executable.
4. Transcript persistence, feedback submission, tool calling, network access, and direct
   React invocation are absent and covered by static/adversarial tests.
5. Every output is request/sequence bound, capped, cancellable, and revalidated by the
   sidecar. Wrong/stale/late events refuse.
6. OS/SDK/bridge/prompt-profile/observed-generation changes invalidate the attestation and
   calibration descriptor; unavailable generation observability and its silent-drift limit are
   explicit.
7. The spike publishes only public/synthetic aggregate evidence. Private use requires a
   separately reviewed calibration/privacy promotion.

## Primary sources

- [Apple Foundation Models: `SystemLanguageModel`](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel)
- [Apple Foundation Models: `LanguageModelSession`](https://developer.apple.com/documentation/foundationmodels/languagemodelsession)
- [Apple WWDC: Meet the Foundation Models framework](https://developer.apple.com/videos/play/wwdc2025/286/)
- [Foundation Models update notes](https://developer.apple.com/documentation/updates/foundationmodels)

The checked documentation includes beta/change warnings. Re-verify the exact final SDK and
OS behavior before implementation or distribution.
