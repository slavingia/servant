// Token usage per agent turn, for the built-in leaderboard. One row per finished
// agent reply: who asked, where (private agent chat or channel), and the token
// counts Hermes reported. No prompt text is stored here.
import { DatabaseSync } from "node:sqlite";
import { classifyTopic, topicReport, productContext } from "./usage-topics.mjs";

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
// Daily limits scale with the agent tier (see agentTierOf): 1 tester, 2 vibe coder, 3 design engineer.
export const TIER_TOKEN_LIMITS = { 0: 0, 1: 1_000_000, 2: 5_000_000, 3: 20_000_000, 4: 5_000_000 };
// 4 = Researcher (11/6): web, search, vision and skills on a bridge with no shell or files, so no GitHub at all.
// The number is a label, not a rank: it sits beside the others rather than above them.
export const AGENT_TIERS = { 0: "No agent", 1: "Tester", 2: "Vibe coder", 3: "Design engineer", 4: "Researcher" };
export const RESEARCHER_TIER = 4;
// Owners are tier 3. People who joined before tiers keep what they had (vibe coder = 2, otherwise 1);
// everyone who joins now starts at 0 (agentTier is written when they join).
export function agentTierOf(user) {
  if (!user) return 0;
  if (user.role === "owner") return 3;
  if (Number.isInteger(user.agentTier) && user.agentTier >= 0 && user.agentTier <= 4) return user.agentTier;
  return user.vibeCoder ? 2 : 1;
}
export const startOfDay = (at = Date.now()) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const limitMessage = (limit = DAILY_TOKEN_LIMIT) =>
  `You've reached today's limit of ${limit.toLocaleString("en-US")} tokens. It resets at midnight`;

// topics(): { name, context } from config.json usageTopics, read on each use so edits apply without a restart.
export function createUsageStore(file, { limit = DAILY_TOKEN_LIMIT, clock = Date.now, topics = () => ({}) } = {}) {
  let cached = { key: null, re: null };
  const context = () => {
    const words = topics()?.context || [];
    const key = JSON.stringify(words);
    if (cached.key !== key) cached = { key, re: productContext(words) };
    return cached.re;
  };
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
  if (!db.prepare("PRAGMA table_info(token_usage)").all().some(c => c.name === "chat_id")) db.exec("ALTER TABLE token_usage ADD COLUMN chat_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS token_usage_chat ON token_usage(chat_id)");
  // Survey-feedback theme and kind of work, labelled from the request when it is recorded (labels only, no text).
  for (const col of ["theme", "kind"]) if (!db.prepare("PRAGMA table_info(token_usage)").all().some(c => c.name === col)) db.exec(`ALTER TABLE token_usage ADD COLUMN ${col} TEXT`);
  const insert = db.prepare(`INSERT OR IGNORE INTO token_usage(event_id,user_id,source,input_tokens,output_tokens,total_tokens,at,chat_id,theme,kind)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  return {
    // eventId makes a retried/recovered turn count once.
    record({ eventId, userId, source, usage, chatId, text, at = Date.now() }) {
      const u = normalizeUsage(usage);
      if (!u || !userId) return false;
      const topic = text == null ? {} : classifyTopic(text, context());
      return insert.run(eventId ?? null, String(userId), source === "channel" ? "channel" : "chat", u.input, u.output, u.total, at, chatId ? String(chatId) : null, topic.theme ?? null, topic.kind ?? null).changes > 0;
    },
    // What one conversation has used so far, for the line above its composer.
    chatTotals(chatId) {
      const r = db.prepare("SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(total_tokens),0) AS total, COUNT(*) AS turns FROM token_usage WHERE chat_id=?").get(String(chatId));
      return { input: Number(r.input), output: Number(r.output), total: Number(r.total), turns: Number(r.turns) };
    },
    limit,
    limitFor(user) { return limit === DAILY_TOKEN_LIMIT ? TIER_TOKEN_LIMITS[agentTierOf(user)] : limit * (TIER_TOKEN_LIMITS[agentTierOf(user)] / DAILY_TOKEN_LIMIT); },
    usedToday: userId => Number(db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS n FROM token_usage WHERE user_id=? AND at>=?").get(String(userId), startOfDay(clock())).n),
    // The owner is unlimited, and so is anyone flagged `unlimitedTokens` (testers).
    overLimit(user) { return !!user && (agentTierOf(user) === 0 || (user.role !== "owner" && !user.unlimitedTokens)) && this.usedToday(user.id) >= this.limitFor(user); },
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
    // Label rows recorded before topics existed: labels is { eventId: text }. Returns rows labelled.
    backfillTopics(texts) {
      const set = db.prepare("UPDATE token_usage SET theme=?, kind=? WHERE event_id=? AND theme IS NULL");
      let n = 0;
      for (const [eventId, text] of Object.entries(texts)) { const t = classifyTopic(text, context()); n += Number(set.run(t.theme, t.kind, eventId).changes); }
      return n;
    },
    // Tokens by survey-feedback theme, read against what survey respondents said.
    topics({ since = 0 } = {}) {
      const rows = db.prepare(`SELECT theme, SUM(total_tokens) AS total, COUNT(*) AS turns,
          SUM(CASE WHEN kind='technical_bug' THEN total_tokens ELSE 0 END) AS bug,
          SUM(CASE WHEN kind='feature_request' THEN total_tokens ELSE 0 END) AS feature
        FROM token_usage WHERE at >= ? AND theme IS NOT NULL GROUP BY theme`).all(since)
        .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
      const unlabelled = Number(db.prepare("SELECT COUNT(*) AS n FROM token_usage WHERE at >= ? AND theme IS NULL").get(since).n);
      return { ...topicReport(rows, { name: topics()?.name }), unlabelledTurns: unlabelled };
    },
    close: () => db.close(),
  };
}
