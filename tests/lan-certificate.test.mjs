import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import https from "node:https";

const require = createRequire(import.meta.url);
const { ensureLanCertificate, findOpenSsl, lanAddresses } = require("../desktop/lan-certificate.cjs");
const { startLocalApi } = require("../desktop/local-api.cjs");

const roots = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

it("uses the current Wi-Fi or Ethernet interface for QR pairing instead of virtual networks", () => {
  const addresses = lanAddresses({
    preferredInterface: "en0",
    networkInterfaces: {
      feth123: [{ family: "IPv4", address: "192.168.194.11", internal: false }],
      en0: [{ family: "IPv4", address: "192.168.68.111", internal: false }],
      en10: [{ family: "IPv4", address: "169.254.23.248", internal: false }],
      utun1: [{ family: "IPv4", address: "100.125.244.16", internal: false }],
    },
  });
  assert.deepEqual(addresses, ["192.168.68.111"]);
});

it("falls back to a physical private LAN address when no default route is available", () => {
  const addresses = lanAddresses({
    networkInterfaces: {
      bridge0: [{ family: "IPv4", address: "192.168.10.1", internal: false }],
      en1: [{ family: "IPv4", address: "10.0.0.9", internal: false }],
      en2: [{ family: "IPv4", address: "203.0.113.9", internal: false }],
    },
  });
  assert.deepEqual(addresses, ["10.0.0.9"]);
});

it("creates a reusable local TLS certificate with a stable public fingerprint", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kcc-lan-certificate-"));
  roots.push(root);
  const opensslPath = findOpenSsl();
  const first = ensureLanCertificate({ directory: root, opensslPath });
  const second = ensureLanCertificate({ directory: root, opensslPath });
  assert.match(first.fingerprint_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.fingerprint_sha256, second.fingerprint_sha256);
  assert.equal(first.key_path, second.key_path);
});

it("keeps the desktop loopback API private while serving the versioned API over explicit LAN TLS", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kcc-lan-runtime-"));
  roots.push(root);
  const certificate = ensureLanCertificate({ directory: join(root, "tls"), opensslPath: findOpenSsl() });
  const runtime = await startLocalApi({
    dataFile: join(root, "cards.json"),
    modelsDir: join(root, "models"),
    seedPath: join(process.cwd(), "desktop", "seed.json"),
    migrateFromUrl: "",
  });
  try {
    const lan = await runtime.startLanApi({ keyPath: certificate.key_path, certPath: certificate.cert_path, port: 0 });
    const descriptor = await new Promise((resolve, reject) => {
      https.get(`https://127.0.0.1:${lan.port}/api/v1`, { rejectUnauthorized: false }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }).on("error", reject);
    });
    assert.equal(descriptor.status, 200);
    assert.ok(descriptor.body.capabilities.includes("devices.pairing"));
  } finally {
    await runtime.close();
  }
});
