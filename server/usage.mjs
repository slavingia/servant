// Token usage per agent turn, for the built-in leaderboard. One row per finished
// agent reply: who asked, where (private agent chat or channel), and the token
// counts Hermes reported. No prompt text is stored here.
import { DatabaseSync } from "node:sqlite";

const int = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);

// Hermes reports { input_tokens, output_tokens, total_tokens }; OpenAI-style
// payloads use prompt_/completion_tokens. Returns null when nothing was counted.
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = int(raw.input_tokens ?? raw.prompt_tokens);
  const output = int(raw.output_tokens ?? raw.completion_tokens);
  const total = int(raw.total_tokens) || input + output;
  if (!input && !output && !total) return null;
  return { input, output, total };
}

// Everyone but the owner may use up to this many tokens a day (server-local day).
export const DAILY_TOKEN_LIMIT = 1_000_000;
export const startOfDay = (at = Date.now()) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const limitMessage = (limit = DAILY_TOKEN_LIMIT) =>
  `You've reached today's limit of ${limit.toLocaleString("en-US")} tokens. It resets at midnight`;

export function createUsageStore(file, { limit = DAILY_TOKEN_LIMIT, clock = Date.now } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY,
      event_id TEXT UNIQUE,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_usage_at ON token_usage(at);
    CREATE INDEX IF NOT EXISTS token_usage_user ON token_usage(user_id, at);`);
  const insert = db.prepare(`INSERT OR IGNORE INTO token_usage(event_id,user_id,source,input_tokens,output_tokens,total_tokens,at)
    VALUES (?,?,?,?,?,?,?)`);
  return {
    // eventId makes a retried/recovered turn count once.
    record({ eventId, userId, source, usage, at = Date.now() }) {
      const u = normalizeUsage(usage);
      if (!u || !userId) return false;
      return insert.run(eventId ?? null, String(userId), source === "channel" ? "channel" : "chat", u.input, u.output, u.total, at).changes > 0;
    },
    limit,
    usedToday: userId => Number(db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS n FROM token_usage WHERE user_id=? AND at>=?").get(String(userId), startOfDay(clock())).n),
    // The owner is unlimited.
    overLimit(user) { return !!user && user.role !== "owner" && this.usedToday(user.id) >= limit; },
    leaderboard({ since = 0 } = {}) {
      const rows = db.prepare(`SELECT user_id AS userId, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
          SUM(total_tokens) AS total, COUNT(*) AS turns,
          SUM(CASE WHEN source='chat' THEN total_tokens ELSE 0 END) AS chat,
          SUM(CASE WHEN source='channel' THEN total_tokens ELSE 0 END) AS channel
        FROM token_usage WHERE at >= ? GROUP BY user_id ORDER BY total DESC, turns DESC`).all(since);
      const totals = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
          COALESCE(SUM(total_tokens),0) AS total, COUNT(*) AS turns FROM token_usage WHERE at >= ?`).get(since);
      const plain = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));
      return { totals: plain(totals), people: rows.map(plain) };
    },
    close: () => db.close(),
  };
}
