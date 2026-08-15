const { spawn } = require("node:child_process");

const SERVICE_TYPE = "_kcc._tcp";

function advertiseKnowledgeCardHost({ port, fingerprint }) {
  const process = spawn("/usr/bin/dns-sd", ["-R", "Knowledge Card Cabinet", SERVICE_TYPE, "local", String(port), "path=/api/v1", `fingerprint=${fingerprint}`], {
    stdio: "ignore",
  });
  return {
    stop() {
      if (!process.killed) process.kill();
    },
  };
}

module.exports = { SERVICE_TYPE, advertiseKnowledgeCardHost };
