#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function targetTriple() {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc.exe";
  throw new Error(`Unsupported verification host ${process.platform}/${process.arch}`);
}

function resolveBinary() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const name = `app-sidecar-${targetTriple()}`;
  const candidates = [
    path.join(repoRoot, "sidecar-bin", name),
    path.join(repoRoot, "vendor", "gemini-web", "binaries", name),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No host sidecar found; checked: ${candidates.join(", ")}`);
  return found;
}

function nonLoopbackIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("A non-loopback IPv4 interface is required for the exposure probe");
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a TCP port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function requestHealth(host, port) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: "/api/health", timeout: 750 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          // Reachability is recorded independently from a valid JSON body.
        }
        resolve({ reachable: true, status: response.statusCode, json });
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ reachable: false, status: null, json: null }));
  });
}

async function waitForExpectedHealth(child, port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Sidecar exited early with code ${child.exitCode}`);
    const health = await requestHealth("127.0.0.1", port);
    if (health.reachable) {
      if (health.status !== 200) throw new Error(`Sidecar health returned HTTP ${health.status}`);
      if (health.json?.runtime_mode !== "local" || health.json?.bind_scope !== "loopback") {
        throw new Error(`Sidecar reported an incompatible runtime contract: ${JSON.stringify(health.json)}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Sidecar did not report expected local/loopback health within 15 seconds");
}

async function requireInvalidModeToFailBeforeListening(child, port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const health = await requestHealth("127.0.0.1", port);
    if (health.reachable) throw new Error("Invalid-mode sidecar opened a listening socket");
    if (child.exitCode !== null) {
      if (child.exitCode === 0) throw new Error("Invalid-mode sidecar exited successfully");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Invalid-mode sidecar neither failed nor listened within 5 seconds");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await closed;
  clearTimeout(timer);
}

const binary = resolveBinary();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apodictic-sidecar-contract-"));
const port = await reservePort();
let diagnostics = "";
let child;

try {
  const publicResources = fs.existsSync(path.join(repoRoot, "public"))
    ? path.join(repoRoot, "public")
    : path.join(repoRoot, "vendor", "gemini-web");
  const inherited = ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"];
  const env = Object.fromEntries(inherited.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(env, {
    HOME: tempRoot,
    USERPROFILE: tempRoot,
    APP_DATA_PATH: path.join(tempRoot, "data"),
    PUBLIC_RESOURCES_PATH: publicResources,
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 0x5a).toString("base64"),
    APODICTIC_RUNTIME_MODE: "local",
    PORT: String(port),
  });

  child = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (error) => {
    diagnostics += `spawn error: ${error.message}\n`;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      if (diagnostics.length < 64 * 1024) diagnostics += chunk.toString();
    });
  }

  await waitForExpectedHealth(child, port);
  const exposed = await requestHealth(nonLoopbackIpv4(), port);
  if (exposed.reachable) throw new Error("Local-mode sidecar was reachable through a non-loopback interface");
  await stopChild(child);
  child = undefined;

  diagnostics = "";
  child = spawn(binary, [], {
    env: { ...env, APODICTIC_RUNTIME_MODE: " local" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => {
    diagnostics += `spawn error: ${error.message}\n`;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      if (diagnostics.length < 64 * 1024) diagnostics += chunk.toString();
    });
  }
  await requireInvalidModeToFailBeforeListening(child, port);
  console.log(`✓ sidecar runtime contract verified (${path.basename(binary)}: local, loopback-only, invalid-mode fail-closed)`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  if (diagnostics.trim()) console.error(diagnostics.trim());
  process.exitCode = 1;
} finally {
  if (child) await stopChild(child);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
