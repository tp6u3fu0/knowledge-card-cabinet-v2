import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

const require = createRequire(import.meta.url);
const { createUpdateCheck, isNewerVersion, repositorySlug } = require("../desktop/update-check.cjs");

const roots = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "kcc-update-"));
  roots.push(root);
  return root;
}

/** A GitHub that answers with whatever the test says, and counts the asking. */
function stubGitHub(release, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => release,
    };
  };
  return { fetchImpl, calls };
}

const repository = { type: "git", url: "git+https://github.com/tp6u3fu0/knowledge-card-cabinet-v2.git" };

it("reads the repository out of the manifest instead of hardcoding one", () => {
  assert.equal(repositorySlug(repository), "tp6u3fu0/knowledge-card-cabinet-v2");
  assert.equal(repositorySlug("https://github.com/someone/fork"), "someone/fork");
  assert.equal(repositorySlug("git@github.com:someone/fork.git"), "someone/fork");
  // A fork that points somewhere else entirely must not silently fall back to
  // this repository — it gets no update check at all.
  assert.equal(repositorySlug("https://gitlab.com/someone/fork.git"), "");
  assert.equal(repositorySlug(undefined), "");
});

it("only counts three whole numbers as a newer version", () => {
  assert.equal(isNewerVersion("1.0.1", "1.0.0"), true);
  assert.equal(isNewerVersion("1.1.0", "1.0.9"), true);
  assert.equal(isNewerVersion("2.0.0", "1.9.9"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("0.9.0", "1.0.0"), false);
  // 10 is not "1.0" spelled differently.
  assert.equal(isNewerVersion("1.0.10", "1.0.9"), true);
  // A prerelease is not something anyone is being sent to.
  assert.equal(isNewerVersion("1.1.0-beta.1", "1.0.0"), false);
  assert.equal(isNewerVersion("latest", "1.0.0"), false);
});

it("offers the new version and a link to it, or neither", async () => {
  const root = await workspace();
  const { fetchImpl } = stubGitHub({
    tag_name: "v1.2.0",
    html_url: "https://github.com/tp6u3fu0/knowledge-card-cabinet-v2/releases/tag/v1.2.0",
  });
  const check = createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath: join(root, "update-check.json"),
    fetchImpl,
  });

  // Before anything has been asked, the version is still known.
  assert.deepEqual(check.status(), {
    version: "1.0.0",
    update_check: "on",
    latest_version: null,
    release_url: null,
    update_available: false,
    checked_at: null,
  });

  const result = await check.check();
  assert.equal(result.version, "1.0.0");
  assert.equal(result.latest_version, "1.2.0");
  assert.equal(result.update_available, true);
  assert.match(result.release_url, /releases\/tag\/v1\.2\.0$/u);
});

it("says nothing when the newest release is the one already running", async () => {
  const root = await workspace();
  const { fetchImpl } = stubGitHub({ tag_name: "v1.0.0", html_url: "https://example.invalid/r/1.0.0" });
  const check = createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath: join(root, "update-check.json"),
    fetchImpl,
  });
  const result = await check.check();
  assert.equal(result.update_available, false);
  // The link is withheld too: there is nothing to click through to.
  assert.equal(result.release_url, null);
});

it("asks at most once a day, and remembers across restarts", async () => {
  const root = await workspace();
  const statePath = join(root, "update-check.json");
  const { fetchImpl, calls } = stubGitHub({ tag_name: "v1.4.0", html_url: "https://example.invalid/r/1.4.0" });

  const first = createUpdateCheck({ currentVersion: "1.0.0", repository, statePath, fetchImpl });
  await first.check();
  await first.check();
  await first.check();
  assert.equal(calls.length, 1, "a second call within the day went to the network again");

  // A restart reads the recorded time rather than starting over.
  const restarted = createUpdateCheck({ currentVersion: "1.0.0", repository, statePath, fetchImpl });
  const afterRestart = await restarted.check();
  assert.equal(calls.length, 1, "restarting the app asked again");
  assert.equal(afterRestart.latest_version, "1.4.0", "the answer was not carried across the restart");

  // A day later it is allowed to ask again.
  const tomorrow = createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath,
    fetchImpl,
    now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
  });
  await tomorrow.check();
  assert.equal(calls.length, 2);
});

it("treats being offline as having nothing to say", async () => {
  const root = await workspace();
  const statePath = join(root, "update-check.json");
  let attempts = 0;
  const check = createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    },
  });

  const result = await check.check();
  assert.equal(result.version, "1.0.0", "a failed check must still report the local version");
  assert.equal(result.update_available, false);
  assert.equal(result.latest_version, null);

  // The failure is recorded, so a machine with no network does not reach for
  // it again on every single request.
  await check.check();
  assert.equal(attempts, 1);
});

it("is refused by a rate limit without breaking", async () => {
  const root = await workspace();
  const { fetchImpl } = stubGitHub({ message: "API rate limit exceeded" }, { status: 403 });
  const check = createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath: join(root, "update-check.json"),
    fetchImpl,
  });
  const result = await check.check();
  assert.equal(result.update_available, false);
  assert.equal(result.version, "1.0.0");
});

it("can be switched off entirely", async () => {
  const root = await workspace();
  let asked = false;
  // An answer left on disk from before the switch was thrown.
  await writeFile(join(root, "update-check.json"), JSON.stringify({
    checked_at: new Date().toISOString(),
    latest_version: "9.9.9",
    release_url: "https://example.invalid/r/9.9.9",
  }), "utf8");
  const result = await createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath: join(root, "update-check.json"),
    enabled: false,
    fetchImpl: async () => {
      asked = true;
      throw new Error("must not be called");
    },
  }).check();
  assert.equal(asked, false, "KCC_UPDATE_CHECK=off still called home");
  assert.equal(result.update_check, "off");
  assert.equal(result.version, "1.0.0", "switching the check off also hid the version");
  // Off is silent, not merely quiet: an answer left on disk from before is not
  // reported either, or turning it off would still nag about the same release.
  assert.equal(result.update_available, false);
  assert.equal(result.latest_version, null);
});

it("identifies itself to GitHub and nothing more", async () => {
  const root = await workspace();
  const { fetchImpl, calls } = stubGitHub({ tag_name: "v1.1.0", html_url: "https://example.invalid/r" });
  const check = createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath: join(root, "update-check.json"),
    fetchImpl,
  });
  await check.check();

  assert.equal(calls[0].url, "https://api.github.com/repos/tp6u3fu0/knowledge-card-cabinet-v2/releases/latest");
  // GitHub rejects a request with no User-Agent, so one is sent — but it is
  // the program's name alone. Nothing here should distinguish one machine,
  // one install, or one version from another.
  const sent = JSON.stringify(calls[0].headers);
  assert.match(sent, /knowledge-card-cabinet/u);
  assert.doesNotMatch(sent, /1\.0\.0/u, "the request tells GitHub which build is running");
});

it("ignores a state file that has been corrupted or edited", async () => {
  const root = await workspace();
  const statePath = join(root, "update-check.json");
  await writeFile(statePath, "{ not json at all", "utf8");
  const { fetchImpl } = stubGitHub({ tag_name: "v1.5.0", html_url: "https://example.invalid/r/1.5.0" });
  const check = createUpdateCheck({ currentVersion: "1.0.0", repository, statePath, fetchImpl });

  const result = await check.check();
  assert.equal(result.latest_version, "1.5.0");
  const written = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(written.latest_version, "1.5.0");
});

it("does not believe a state file claiming an impossible latest version", async () => {
  const root = await workspace();
  const statePath = join(root, "update-check.json");
  await writeFile(statePath, JSON.stringify({
    checked_at: new Date().toISOString(),
    latest_version: "99.0.0-attacker",
    release_url: "https://example.invalid/not-a-release",
  }), "utf8");
  const check = createUpdateCheck({
    currentVersion: "1.0.0",
    repository,
    statePath,
    fetchImpl: async () => {
      throw new Error("must not be called: the state is still fresh");
    },
  });
  assert.equal(check.status().update_available, false);
  assert.equal(check.status().latest_version, null);
});
