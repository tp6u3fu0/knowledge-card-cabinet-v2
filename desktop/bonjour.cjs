const { spawn } = require("node:child_process");

const SERVICE_TYPE = "_kcc._tcp";

/**
 * The mDNS responder to drive, per platform.
 *
 * macOS has `dns-sd` in the base system. Windows only has it when Apple's
 * Bonjour service is installed (it ships with iTunes and with Bonjour Print
 * Services), so discovery there is a bonus rather than something to rely on —
 * which is why the pairing QR code carries the host address outright instead of
 * assuming the phone can find it.
 */
function responderCommand() {
  if (process.platform === "darwin") return { file: "/usr/bin/dns-sd", register: "-R" };
  if (process.platform === "win32") return { file: "dns-sd.exe", register: "-R" };
  return null;
}

const MISSING_RESPONDER = "這台電腦沒有 mDNS 服務，裝置請改用 QR code 或手動輸入位址。";

function advertiseKnowledgeCardHost({ port, fingerprint }) {
  const command = responderCommand();
  if (!command) {
    return { active: false, detail: MISSING_RESPONDER, ready: Promise.resolve(), stop() {} };
  }

  let child;
  const advertisement = {
    active: false,
    detail: "",
    stop() {
      advertisement.active = false;
      if (child && !child.killed) child.kill();
      child = undefined;
    },
  };

  try {
    child = spawn(command.file, [
      command.register,
      "Knowledge Card Cabinet",
      SERVICE_TYPE,
      "local",
      String(port),
      "path=/api/v1",
      `fingerprint=${fingerprint}`,
    ], { stdio: "ignore", windowsHide: true });
  } catch {
    return { active: false, detail: MISSING_RESPONDER, ready: Promise.resolve(), stop() {} };
  }

  // Whether the responder exists is only known asynchronously, so the caller
  // gets a promise to await rather than a status that starts out optimistic and
  // silently turns false a tick later.
  advertisement.ready = new Promise((resolve) => {
    child.once("spawn", () => {
      advertisement.active = true;
      resolve();
    });
    // A missing dns-sd arrives as an 'error' event, and an unhandled one on a
    // ChildProcess throws — which would take the whole main process down on any
    // Windows machine without Apple's Bonjour installed.
    child.once("error", () => {
      advertisement.active = false;
      advertisement.detail = MISSING_RESPONDER;
      child = undefined;
      resolve();
    });
  });

  child.once("exit", () => {
    if (advertisement.active) {
      advertisement.active = false;
      advertisement.detail = "mDNS 廣播已結束，裝置請改用 QR code 配對。";
    }
    child = undefined;
  });

  return advertisement;
}

module.exports = { SERVICE_TYPE, advertiseKnowledgeCardHost };
