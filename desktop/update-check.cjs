/**
 * Whether a newer release exists — asked rarely, answered offline.
 *
 * There is no auto-updater. On macOS one would need the app signed, and it is
 * not; on Windows it would mean shipping an update server's worth of moving
 * parts into a program whose whole promise is that it keeps to itself. So the
 * app does the smallest thing that still means a fix can reach someone: it
 * looks up the newest published release and shows a line with a link. The
 * person installs it themselves, exactly as they installed the first one.
 *
 * Three properties matter more than the feature:
 *
 *   - It never blocks. The check is asked for by a request that is already
 *     answering with the local version; the network part only ever adds to it.
 *   - It never throws. Offline, rate-limited, behind a proxy, GitHub down —
 *     all of them mean "no answer yet", not an error the reader has to see.
 *   - It is rare and switchable. Once a day at most, remembered across
 *     restarts, and `KCC_UPDATE_CHECK=off` stops it entirely. A local-first
 *     app that quietly calls home on every launch has broken its own promise.
 */
const fs = require("node:fs");
const path = require("node:path");

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Releases are compared as three numbers and nothing else.
 *
 * Anything with a prerelease or build suffix is not a version this app offers
 * to anyone: `1.1.0-beta.1` must never look newer than `1.0.0`, and the safe
 * way to guarantee that is to refuse to read it at all.
 */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(text ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewerVersion(candidate, current) {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/**
 * "owner/name" out of whatever package.json's `repository` field holds.
 *
 * It is read rather than hardcoded so that a fork checks its own releases
 * instead of pointing its users at this repository's downloads.
 */
function repositorySlug(repository) {
  const url = typeof repository === "string" ? repository : repository?.url ?? "";
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(String(url).trim());
  return match ? `${match[1]}/${match[2]}` : "";
}

function readState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      checked_at: typeof state.checked_at === "string" ? state.checked_at : "",
      latest_version: parseVersion(state.latest_version) ? String(state.latest_version) : "",
      release_url: typeof state.release_url === "string" ? state.release_url : "",
    };
  } catch {
    return { checked_at: "", latest_version: "", release_url: "" };
  }
}

function writeState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Not being able to remember the last check only costs an extra request.
  }
}

function createUpdateCheck({
  currentVersion,
  repository,
  statePath = "",
  enabled = true,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const slug = repositorySlug(repository);
  const active = Boolean(enabled && slug && fetchImpl && parseVersion(currentVersion));
  let state = statePath ? readState(statePath) : { checked_at: "", latest_version: "", release_url: "" };
  let inFlight = null;

  function status() {
    // The latest version is only ever reported alongside a link to it: a
    // number the reader cannot act on is worse than no number. Switched off
    // means silent too — someone who turned this off is asking not to be told
    // about releases, not merely asking to stop the request.
    const newer = Boolean(state.release_url) && isNewerVersion(state.latest_version, currentVersion);
    if (!active) return { version: currentVersion, update_check: "off", latest_version: null, release_url: null, update_available: false, checked_at: null };
    return {
      version: currentVersion,
      update_check: "on",
      latest_version: state.latest_version || null,
      release_url: newer ? state.release_url : null,
      update_available: newer,
      checked_at: state.checked_at || null,
    };
  }

  function isFresh() {
    const last = Date.parse(state.checked_at || "");
    return Number.isFinite(last) && now().getTime() - last < CHECK_INTERVAL_MS;
  }

  async function fetchLatest() {
    // GitHub rejects requests without a User-Agent. The name is sent and
    // nothing else — no version, no identifier, nothing that would let a run
    // be told apart from any other run of the same program.
    const response = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "knowledge-card-cabinet" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    const version = parseVersion(release?.tag_name) ? String(release.tag_name).replace(/^v/u, "") : "";
    if (!version) throw new Error("release has no usable version");
    return {
      checked_at: now().toISOString(),
      latest_version: version,
      release_url: typeof release?.html_url === "string" ? release.html_url : "",
    };
  }

  async function check() {
    if (!active || isFresh()) return status();
    // Several tabs opening at once must not become several requests, and the
    // second caller should wait for the first answer rather than start again.
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const next = await fetchLatest();
          state = next;
          if (statePath) writeState(statePath, next);
        } catch {
          // No answer is a normal outcome. Record the attempt so a machine
          // that is simply offline does not retry on every single request.
          state = { ...state, checked_at: now().toISOString() };
          if (statePath) writeState(statePath, state);
        }
      })();
    }
    const pending = inFlight;
    try {
      await pending;
    } finally {
      if (inFlight === pending) inFlight = null;
    }
    return status();
  }

  return { status, check };
}

module.exports = { createUpdateCheck, isNewerVersion, parseVersion, repositorySlug };
