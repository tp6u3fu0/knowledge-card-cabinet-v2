import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import https from "node:https";

const require = createRequire(import.meta.url);
const { ensureLanCertificate, lanAddresses, defaultLanAddress } = require("../desktop/lan-certificate.cjs");
const { advertiseKnowledgeCardHost } = require("../desktop/bonjour.cjs");
const { startLocalApi } = require("../desktop/local-api.cjs");

const roots = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

it("uses the current Wi-Fi or Ethernet interface for QR pairing instead of virtual networks", () => {
  const addresses = lanAddresses({
    preferredAddress: "192.168.68.111",
    networkInterfaces: {
      feth123: [{ family: "IPv4", address: "192.168.194.11", internal: false }],
      en0: [{ family: "IPv4", address: "192.168.68.111", internal: false }],
      en10: [{ family: "IPv4", address: "169.254.23.248", internal: false }],
      utun1: [{ family: "IPv4", address: "100.125.244.16", internal: false }],
    },
  });
  assert.deepEqual(addresses, ["192.168.68.111"]);
});

// A Windows machine routinely has more virtual adapters than real ones, and
// their friendly names are the only clue — except for the ones that have no
// clue at all, which is what the routing-table preference is there for.
it("ignores Windows hypervisor, VPN and overlay adapters", () => {
  const networkInterfaces = {
    "Radmin VPN": [{ family: "IPv4", address: "26.89.67.74", internal: false }],
    Tailscale: [{ family: "IPv4", address: "169.254.83.107", internal: false }],
    "乙太網路": [{ family: "IPv4", address: "192.168.68.104", internal: false }],
    "ZeroTier One [76fc96e49895790d]": [{ family: "IPv4", address: "10.28.156.206", internal: false }],
    "VMware Network Adapter VMnet8": [{ family: "IPv4", address: "192.168.152.1", internal: false }],
    "Loopback Pseudo-Interface 1": [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    "vEthernet (WSL (Hyper-V firewall))": [{ family: "IPv4", address: "172.20.64.1", internal: false }],
  };
  assert.deepEqual(lanAddresses({ networkInterfaces }), ["192.168.68.104"]);

  // "乙太網路 3" is a VirtualBox host-only adapter whose name says nothing.
  // Only the default route can tell it apart from the real Ethernet.
  const withHostOnly = { ...networkInterfaces, "乙太網路 3": [{ family: "IPv4", address: "192.168.56.1", internal: false }] };
  assert.deepEqual(lanAddresses({ networkInterfaces: withHostOnly }), ["192.168.68.104", "192.168.56.1"]);
  assert.deepEqual(lanAddresses({ networkInterfaces: withHostOnly, preferredAddress: "192.168.68.104" }), ["192.168.68.104"]);
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

it("asks the routing table for an address without contacting anything", async () => {
  const address = await defaultLanAddress();
  // An offline or VPN-only machine legitimately has no private default route;
  // what must never happen is a hang, a throw, or a non-private answer.
  assert.equal(typeof address, "string");
  if (address) assert.deepEqual(lanAddresses({ preferredAddress: address }), [address]);
});

// Most Windows machines have no dns-sd at all. The failure arrives as an
// asynchronous 'error' event on the child process, which throws if unhandled —
// so getting this wrong takes down the Electron main process rather than just
// losing discovery.
it("reports mDNS availability truthfully and never throws when no responder exists", async () => {
  const advertisement = advertiseKnowledgeCardHost({ port: 8443, fingerprint: "a".repeat(64) });
  await advertisement.ready;
  assert.equal(typeof advertisement.active, "boolean");
  if (!advertisement.active) assert.ok(advertisement.detail, "an inactive advertisement must explain itself to the user");
  advertisement.stop();
  assert.equal(advertisement.active, false);
});

it("creates a reusable local TLS certificate with a stable public fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcc-lan-certificate-"));
  roots.push(root);
  const addresses = ["192.168.68.104"];
  const first = ensureLanCertificate({ directory: root, addresses });
  const second = ensureLanCertificate({ directory: root, addresses });
  assert.match(first.fingerprint_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.fingerprint_sha256, second.fingerprint_sha256);
  assert.equal(first.key_path, second.key_path);
});

it("keeps the desktop loopback API private while serving the versioned API over explicit LAN TLS", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcc-lan-runtime-"));
  roots.push(root);
  const certificate = ensureLanCertificate({ directory: join(root, "tls"), addresses: ["192.168.68.104"] });
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
