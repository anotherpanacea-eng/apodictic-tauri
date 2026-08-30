import assert from "node:assert/strict";
import test from "node:test";

import {
  FORBIDDEN_CREDENTIALS,
  childEnvironment,
  definedForbiddenCredentials,
} from "../run-macos-packaging-probe.mjs";
import {
  expectedHostTarget,
  validateReceipt,
} from "../verify-macos-packaging-probe.mjs";

function validReceipt() {
  return {
    schema_version: 1,
    probe_name: "UNSIGNED-NON-DISTRIBUTABLE-PACKAGING-PROBE",
    source_commit: "1646d0970f8756bdfb8667322c43bc567bf7ea36",
    payload_tag: "v0.2.1",
    payload_commit: "268341b69020a6c7973d5584199c580ecc19c663",
    lock_sha256: "a".repeat(64),
    host_os_version: "14.7",
    host_arch: "arm64",
    target_triple: "aarch64-apple-darwin",
    rustc_version: "rustc 1.94.1",
    cargo_version: "cargo 1.94.1",
    node_version: "v22.0.0",
    tauri_cli_version: "tauri-cli 2.11.3",
    bundle_identifier: "com.anotherpanacea.apodictic",
    bundle_version: "0.1.0",
    minimum_system_version: "14.0",
    app_arches: ["arm64"],
    sidecar_arches: ["arm64"],
    bundle_tree_sha256: "b".repeat(64),
    distribution_ready: false,
    developer_id_signed: false,
    notarization_proven: false,
    sbom_complete: false,
    notices_complete: false,
    m0_status: "NO-GO",
    canonical_gate_record: "fleet-coordination/handoffs/CODE-MAC-APODICTIC-M0-INVENTORY-2026-07-21.md",
  };
}

test("credential guard treats an empty forbidden variable as defined", () => {
  assert.deepEqual(definedForbiddenCredentials({ APPLE_SIGNING_IDENTITY: "" }), ["APPLE_SIGNING_IDENTITY"]);
  assert.deepEqual(definedForbiddenCredentials({ PATH: "/bin" }), []);
});

test("credential guard covers the frozen probe boundary", () => {
  assert.deepEqual(FORBIDDEN_CREDENTIALS, [
    "GEMINI_SYNC_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
    "AC_API_KEY_ID",
    "AC_API_ISSUER_ID",
    "AC_API_KEY",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "CREDENTIAL_ENCRYPTION_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GPT_ACTIONS_API_KEY",
    "ARTIFACT_SIGNING_SECRET",
  ]);
});

test("child environment contains only the frozen allowlist and probe target", () => {
  const filtered = childEnvironment("probe-target", {
    PATH: "/bin",
    HOME: "/safe-home",
    LANG: "en_US.UTF-8",
    UNLISTED: "drop-me",
    GITHUB_TOKEN: "drop-me-too",
  });
  assert.deepEqual(filtered, {
    PATH: "/bin",
    HOME: "/safe-home",
    LANG: "en_US.UTF-8",
    CARGO_TARGET_DIR: "probe-target",
  });
});

test("host mapping is exact and rejects unsupported combinations", () => {
  assert.deepEqual(expectedHostTarget("darwin", "arm64"), {
    targetTriple: "aarch64-apple-darwin",
    machArch: "arm64",
  });
  assert.deepEqual(expectedHostTarget("darwin", "x64"), {
    targetTriple: "x86_64-apple-darwin",
    machArch: "x86_64",
  });
  assert.throws(() => expectedHostTarget("linux", "x64"), /unsupported packaging-probe host/);
});

test("receipt validator enforces its closed schema and fixed claims", () => {
  assert.equal(validateReceipt(validReceipt()).schema_version, 1);
  assert.throws(() => validateReceipt({ ...validReceipt(), extra: true }), /closed schema/);
  assert.throws(() => validateReceipt({ ...validReceipt(), distribution_ready: true }), /wrong fixed value/);
  assert.throws(() => validateReceipt({ ...validReceipt(), app_arches: "arm64" }), /one-item string array/);
});

test("receipt validator rejects private roots and absolute path strings", () => {
  assert.throws(
    () => validateReceipt({ ...validReceipt(), rustc_version: "tool at /private/tmp/tool" }),
    /absolute POSIX path/,
  );
  assert.throws(
    () => validateReceipt({ ...validReceipt(), rustc_version: "tool:/private/tmp/tool" }),
    /absolute POSIX path/,
  );
  assert.throws(
    () => validateReceipt({ ...validReceipt(), cargo_version: "cargo private-root build" }, { repoPath: "private-root" }),
    /machine-private string/,
  );
});
