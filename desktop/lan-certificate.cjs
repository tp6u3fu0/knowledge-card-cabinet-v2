const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const forge = require("node-forge");

const CERTIFICATE_DAYS = 3650;

/**
 * Interfaces that own a perfectly valid private address the phone still cannot
 * reach: hypervisor switches, VPN overlays and container bridges. The macOS
 * names are prefixes (utun0, feth1); the Windows ones are substrings of a
 * friendly adapter name ("vEthernet (WSL)", "VMware Network Adapter VMnet8").
 */
const VIRTUAL_INTERFACE_PATTERN = /^(?:utun|feth|vmnet|vboxnet|docker|bridge|llw|awdl|veth|tun|tap)|(?:vethernet|virtualbox|vmware|hyper-v|tailscale|zerotier|radmin|loopback|teredo|npcap|tap-windows|wsl)/iu;

function isVirtualOrOverlayInterface(name) {
  return VIRTUAL_INTERFACE_PATTERN.test(name);
}

function isPrivateLanAddress(address) {
  const octets = String(address).split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

/**
 * The address this machine would use to reach the rest of the network, asked of
 * the routing table rather than of an interface list.
 *
 * A connected UDP socket picks its source address from the default route
 * without sending a single packet, so this works the same on macOS and Windows
 * and needs no `route`/`netsh` subprocess. The destination is TEST-NET-1, which
 * exists only to be unroutable in practice: nothing is contacted either way.
 *
 * This matters more on Windows than on macOS. A developer machine there
 * routinely carries VirtualBox, VMware, WSL and VPN adapters whose names give
 * no hint of being virtual ("乙太網路 3" holding 192.168.56.1), so name
 * filtering alone cannot pick the Wi-Fi out of the list.
 */
function defaultLanAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const finish = (address) => {
      try {
        socket.close();
      } catch {
        // Already closed by the error path.
      }
      resolve(isPrivateLanAddress(address) ? address : "");
    };
    socket.once("error", () => finish(""));
    try {
      socket.connect(53, "192.0.2.1", () => finish(socket.address()?.address || ""));
    } catch {
      finish("");
    }
  });
}

/**
 * The addresses to put in the pairing QR code and the certificate. When the
 * default route is known, that one address wins: showing a phone six candidates
 * and letting it guess is how pairing silently fails on a machine with VPN or
 * hypervisor adapters.
 */
function lanAddresses({ networkInterfaces = os.networkInterfaces(), preferredAddress = "" } = {}) {
  const candidates = Object.entries(networkInterfaces)
    .filter(([name]) => !isVirtualOrOverlayInterface(name))
    .flatMap(([, entries]) => entries || [])
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal && isPrivateLanAddress(entry.address))
    .map((entry) => entry.address);
  const selected = candidates.includes(preferredAddress) ? [preferredAddress] : candidates;
  return selected.filter((address, index, all) => all.indexOf(address) === index);
}

function certificateDetails(certPath) {
  const certificate = new crypto.X509Certificate(fs.readFileSync(certPath));
  return {
    fingerprint_sha256: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
    valid_to: certificate.validTo,
  };
}

/**
 * Generates the self-signed key pair for direct LAN use.
 *
 * The key itself comes from Node's native crypto rather than node-forge's
 * JavaScript RSA generator, which takes seconds for 2048 bits — long enough to
 * look like the app has hung when someone flips on LAN sharing. node-forge only
 * does the X.509 encoding and signing.
 */
function createSelfSignedCertificate(altNames) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    // PKCS#1 rather than PKCS#8: node-forge parses "RSA PRIVATE KEY" directly.
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey);
  certificate.serialNumber = `00${crypto.randomBytes(8).toString("hex")}`;
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + CERTIFICATE_DAYS * 24 * 60 * 60 * 1000);
  const subject = [{ name: "commonName", value: "Knowledge Card Cabinet LAN" }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);
  certificate.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  return { key: privateKey, cert: forge.pki.certificateToPem(certificate) };
}

/**
 * Makes a local, self-signed certificate for direct LAN use. It is deliberately
 * not trusted by the operating system: the iOS pairing flow must pin its
 * fingerprint (or the user may explicitly install it as a trusted profile).
 */
function ensureLanCertificate({ directory, addresses = lanAddresses() } = {}) {
  if (!directory) throw new Error("需要指定 LAN 憑證目錄。");
  const keyPath = path.join(directory, "lan-host.key.pem");
  const certPath = path.join(directory, "lan-host.cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const altNames = [
      { type: 2, value: "kcc.local" },
      ...addresses.map((address) => ({ type: 7, ip: address })),
    ];
    try {
      const { key, cert } = createSelfSignedCertificate(altNames);
      // mode is honoured on macOS and ignored on Windows, where the file
      // inherits the per-user ACL of the app's own data directory.
      fs.writeFileSync(keyPath, key, { encoding: "utf8", mode: 0o600 });
      fs.writeFileSync(certPath, cert, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      try {
        fs.unlinkSync(keyPath);
      } catch {
        // Nothing to clean up.
      }
      try {
        fs.unlinkSync(certPath);
      } catch {
        // Nothing to clean up.
      }
      throw new Error(`無法建立 LAN TLS 憑證：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { key_path: keyPath, cert_path: certPath, ...certificateDetails(certPath) };
}

module.exports = { ensureLanCertificate, lanAddresses, certificateDetails, defaultLanAddress, isPrivateLanAddress };
