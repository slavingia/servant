// A project's README, straight from its GitHub repo: fetched with the server's own gh login,
// cached on disk, refreshed in the background when older than a few minutes, and served stale
// (marked as such) when GitHub can't be reached. Nothing here is stored in the project itself.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const FRESH_MS = 5 * 60 * 1000;
const MAX_CHARS = 200_000;
const inflight = new Map();

function fetchReadme(repo) {
  return new Promise((resolve, reject) => execFile("gh", ["api", `repos/${repo}/readme`, "-H", "Accept: application/vnd.github+json"],
    { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const body = JSON.parse(stdout);
        resolve({ name: body.name || "README.md", text: Buffer.from(body.content || "", "base64").toString("utf8").slice(0, MAX_CHARS), sha: body.sha || "" });
      } catch (e) { reject(e); }
    }));
}

export function createReadmeCache(dir, { fetcher = fetchReadme, now = Date.now } = {}) {
  const fileFor = repo => path.join(dir, `${repo.replace(/[^\w.-]+/g, "_")}.json`);
  const readCached = repo => { try { return JSON.parse(fs.readFileSync(fileFor(repo), "utf8")); } catch { return null; } };
  const refresh = repo => {
    if (!inflight.has(repo)) inflight.set(repo, fetcher(repo).then(r => {
      const entry = { repo, ...r, fetchedAt: now() };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileFor(repo), JSON.stringify(entry), { mode: 0o600 });
      return entry;
    }).finally(() => inflight.delete(repo)));
    return inflight.get(repo);
  };
  const view = (entry, stale) => ({ repo: entry.repo, name: entry.name, text: entry.text, fetchedAt: entry.fetchedAt, stale });
  /** The README for owner/name: cached copy at once when there is one (refreshing behind it if old), else a live fetch. */
  return async function readme(repo) {
    const cached = readCached(repo);
    if (cached) {
      const old = now() - cached.fetchedAt > FRESH_MS;
      if (old) refresh(repo).catch(() => {});
      return view(cached, old);
    }
    try { return view(await refresh(repo), false); } catch { return null; }
  };
}
