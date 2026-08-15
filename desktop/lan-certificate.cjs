const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CERTIFICATE_DAYS = 3650;

function defaultNetworkInterface() {
  if (process.platform !== "darwin") return "";
  try {
    const output = execFileSync("/sbin/route", ["-n", "get", "default"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.match(/^\s*interface:\s*(\S+)\s*$/mu)?.[1] || "";
  } catch {
    return "";
  }
}

function isPrivateLanAddress(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isVirtualOrOverlayInterface(name) {
  return /^(?:utun|feth|vmnet|vboxnet|docker|bridge|llw|awdl)/iu.test(name);
}

/**
 * The pairing QR code needs one address the phone can reach. On macOS the
 * default-route interface is the current Wi-Fi/Ethernet network; virtual and
 * overlay interfaces often have otherwise-valid private addresses but are not
 * reachable by another device on that LAN.
 */
function lanAddresses({ networkInterfaces = os.networkInterfaces(), preferredInterface = defaultNetworkInterface() } = {}) {
  const candidates = Object.entries(networkInterfaces)
    .filter(([name]) => !isVirtualOrOverlayInterface(name))
    .flatMap(([name, entries]) => (entries || []).map((entry) => ({ name, entry })))
    .filter(({ entry }) => entry && entry.family === "IPv4" && !entry.internal && isPrivateLanAddress(entry.address));
  const preferred = preferredInterface
    ? candidates.filter(({ name }) => name === preferredInterface)
    : [];
  const selected = preferred.length > 0 ? preferred : candidates;
  return selected
    .map(({ entry }) => entry.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

function certificateDetails(certPath) {
  const certificate = new crypto.X509Certificate(fs.readFileSync(certPath));
  return {
    fingerprint_sha256: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    valid_to: certificate.validTo,
  };
}

/**
 * Makes a local, self-signed certificate for direct LAN use. It is deliberately
 * not trusted by the operating system: the iOS pairing flow must pin its
 * fingerprint (or the user may explicitly install it as a trusted profile).
 */
function findOpenSsl(preferredPath = "") {
  const candidates = [preferredPath, process.env.KCC_OPENSSL_BIN, "/opt/homebrew/bin/openssl", "/usr/bin/openssl", "openssl"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "openssl" || fs.existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 OpenSSL；macOS LAN 分享需要 OpenSSL 來建立本機 TLS 憑證。");
}

function ensureLanCertificate({ directory, opensslPath = "" } = {}) {
  if (!directory) throw new Error("需要指定 LAN 憑證目錄。");
  const keyPath = path.join(directory, "lan-host.key.pem");
  const certPath = path.join(directory, "lan-host.cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const altNames = ["DNS:kcc.local", ...lanAddresses().map((address) => `IP:${address}`)].join(",");
    try {
      execFileSync(findOpenSsl(opensslPath), [
        "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", keyPath,
        "-out", certPath,
        "-days", String(CERTIFICATE_DAYS),
        "-subj", "/CN=Knowledge Card Cabinet LAN",
        "-addext", `subjectAltName=${altNames}`,
      ], { stdio: "ignore" });
      fs.chmodSync(keyPath, 0o600);
      fs.chmodSync(certPath, 0o600);
    } catch (error) {
      try { fs.unlinkSync(keyPath); } catch { /* Nothing to clean up. */ }
      try { fs.unlinkSync(certPath); } catch { /* Nothing to clean up. */ }
      throw new Error(`無法建立 LAN TLS 憑證：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { key_path: keyPath, cert_path: certPath, ...certificateDetails(certPath) };
}

module.exports = { ensureLanCertificate, lanAddresses, certificateDetails, defaultNetworkInterface, findOpenSsl };
