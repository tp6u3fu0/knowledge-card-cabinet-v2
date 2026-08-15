const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function constantTimeEquals(first, second) {
  const firstBuffer = Buffer.from(String(first), "utf8");
  const secondBuffer = Buffer.from(String(second), "utf8");
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function readDevices(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.devices) ? parsed.devices : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function writeDevices(filePath, devices) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Best effort on filesystems without POSIX modes. */ }
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    created_at: device.created_at,
    last_used_at: device.last_used_at || null,
    revoked_at: device.revoked_at || null,
  };
}

function createPairingCode() {
  const symbols = Array.from({ length: 8 }, () => PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)]).join("");
  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

function normalizedPairingCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s-]/gu, "");
}

function createDeviceAuth({ storagePath }) {
  let devices = readDevices(storagePath);
  let pendingCode = null;

  const save = () => writeDevices(storagePath, devices);

  return {
    issuePairingCode() {
      const code = createPairingCode();
      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
      pendingCode = { hash: tokenHash(normalizedPairingCode(code)), expiresAt };
      return { code, expires_at: expiresAt };
    },

    pair({ code, name }) {
      const normalizedCode = normalizedPairingCode(code);
      const normalizedName = String(name || "").trim().replace(/\s+/gu, " ").slice(0, 80);
      if (!normalizedCode || !normalizedName) return { ok: false, detail: "需要配對碼與裝置名稱。" };
      if (!pendingCode || Date.parse(pendingCode.expiresAt) <= Date.now()) {
        pendingCode = null;
        return { ok: false, detail: "配對碼已失效，請在桌面版重新產生。" };
      }
      if (!constantTimeEquals(tokenHash(normalizedCode), pendingCode.hash)) return { ok: false, detail: "配對碼不正確。" };

      // A code authorises exactly one device. Clear it before returning a token
      // so a retried network request cannot turn one visible code into two keys.
      pendingCode = null;
      const token = `kcc_dv_${crypto.randomBytes(32).toString("base64url")}`;
      const createdAt = new Date().toISOString();
      const device = {
        id: crypto.randomUUID(),
        name: normalizedName,
        token_hash: tokenHash(token),
        created_at: createdAt,
        last_used_at: createdAt,
        revoked_at: null,
      };
      devices.push(device);
      save();
      return { ok: true, token, device: publicDevice(device) };
    },

    authenticate(token) {
      const digest = tokenHash(token);
      const device = devices.find((candidate) => !candidate.revoked_at && constantTimeEquals(candidate.token_hash, digest));
      if (!device) return null;
      device.last_used_at = new Date().toISOString();
      save();
      return publicDevice(device);
    },

    list() {
      return devices.map(publicDevice).sort((first, second) => String(second.created_at).localeCompare(String(first.created_at)));
    },

    revoke(id) {
      const device = devices.find((candidate) => candidate.id === id);
      if (!device) return null;
      if (!device.revoked_at) {
        device.revoked_at = new Date().toISOString();
        save();
      }
      return publicDevice(device);
    },
  };
}

module.exports = { createDeviceAuth, PAIRING_CODE_TTL_MS };
