// Public surveys are separate from staff accounts and from the development-agent
// inbox. Verified email addresses stay private for staff replies; mailbox IDs
// and verification credentials are keyed or hashed before storage.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { redactSurveyText } from './survey-pii.mjs';

const MAGIC_TTL = 10 * 60_000;
const SESSION_TTL = 24 * 60 * 60_000;
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const token = () => crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
// The page's button is "Send verification link"; a refusal uses the same words, not a second name for the link.
const expiredLink = 'This link is invalid or expired. Send a new verification link';
const VISIBILITY = ['pending', 'reviewed', 'hidden'];
const STATUS = ['open', 'planned', 'resolved'];

// This catches common identifiers, not every kind of personal information.
// Responses and staff review notes stay private to the authorized team.
export function hasSurveyPii(value) {
  const text = String(value).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)
    || /(?:\d[\s().+\-]*){7,}/.test(text);
}

function plainText(value, { field, max, required = false, allowPii = false }) {
  if (typeof value !== 'string') throw fault(400, 'invalid_survey', `Enter ${field}`);
  const text = value.trim();
  // `field` reads after "Enter" ("a survey title"); a refusal that starts with it starts with a capital.
  if ((required && !text) || text.length > max) throw fault(400, 'invalid_survey', `${field[0].toUpperCase()}${field.slice(1)} must be ${required ? '1–' : 'at most '}${max} characters`);
  if (!allowPii && hasSurveyPii(text)) throw fault(400, 'pii_detected', 'Remove personal information such as email addresses, phone numbers, Social Security numbers, and account numbers');
  return text;
}

export function surveyPublicUrl(raw, surveyId) {
  let base;
  try { base = new URL(raw); } catch { throw fault(503, 'survey_url_unavailable', 'The team must configure a public survey address first'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) || base.username || base.password || base.search || base.hash || /^\/hubs(?:\/|$)/.test(base.pathname)) {
    throw fault(503, 'survey_url_unavailable', 'The team must configure a secure public survey address first');
  }
  // Preserve a configured reverse-proxy mount prefix. The encrypted-only relay
  // route above cannot host these public HTML/JSON endpoints.
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/s/${encodeURIComponent(surveyId)}`;
}

// The owner supplies an approved delivery command. Values are JSON on stdin,
// never shell arguments; provider stderr is deliberately not logged or exposed.
export function magicLinkSender(message, settings = {}) {
  const command = settings.mailer?.command;
  if (typeof command !== 'string' || !command.trim()) return Promise.reject(new Error('Email delivery is not configured'));
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Email delivery timed out')); }, 30_000);
    timer.unref();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Email delivery failed')); });
    child.stdin.on('error', () => { /* Process exit reports delivery failure. */ });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Email delivery failed')); });
    child.stdin.end(JSON.stringify(message));
  });
}

function contactEmail(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F]|%0[ad]/i.test(value)) throw fault(400, 'email_invalid', 'Enter one valid email address');
  const email = value.trim().toLowerCase();
  if (!email) return null;
  const [local = '', domain = ''] = email.split('@');
  if (email.length > 254 || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)
    || domain.split('.').some(label => label.length > 63)) {
    throw fault(400, 'email_invalid', 'Enter one valid email address');
  }
  return email;
}

export function createSurveys({ file, now = Date.now, send = magicLinkSender, redact = redactSurveyText }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS survey_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS surveys (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, question TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS survey_responses (
      id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id),
      participant TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), text TEXT NOT NULL, contact_email TEXT,
      visibility TEXT NOT NULL DEFAULT 'pending', status TEXT NOT NULL DEFAULT 'open', reply TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(survey_id, participant), UNIQUE(survey_id, participant, request_id)
    );
    CREATE INDEX IF NOT EXISTS survey_responses_board ON survey_responses(survey_id, visibility);
    CREATE TABLE IF NOT EXISTS survey_votes (
      response_id TEXT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
      participant TEXT NOT NULL, PRIMARY KEY(response_id, participant)
    );
    CREATE TABLE IF NOT EXISTS survey_challenges (
      token_hash TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id), participant TEXT NOT NULL,
      expires_at INTEGER NOT NULL, contact_email TEXT
    );
    CREATE TABLE IF NOT EXISTS survey_sessions (
      token_hash TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id), participant TEXT NOT NULL,
      expires_at INTEGER NOT NULL, contact_email TEXT
    );
    CREATE TABLE IF NOT EXISTS survey_rate_events (bucket TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS survey_rates_bucket ON survey_rate_events(bucket, created_at);
  `);
  // Older databases keep all responses and verification records. A legacy
  // challenge or session has no recoverable email, so its contact stays null.
  for (const table of ['survey_responses', 'survey_challenges', 'survey_sessions']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'contact_email')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN contact_email TEXT`);
    }
  }
  db.prepare('INSERT OR IGNORE INTO survey_secrets VALUES (?, ?)').run('mailbox-hmac', token());
  const secret = db.prepare('SELECT value FROM survey_secrets WHERE key=?').get('mailbox-hmac').value;
  const opaque = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const sweep = () => {
    db.prepare('DELETE FROM survey_challenges WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM survey_sessions WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM survey_rate_events WHERE created_at<=?').run(now() - 60 * 60_000);
  };
  const surveyRow = surveyId => {
    const row = db.prepare('SELECT * FROM surveys WHERE id=?').get(String(surveyId));
    if (!row) throw fault(404, 'survey_not_found', 'This survey could not be found');
    return row;
  };
  const surveyView = row => {
    const counts = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(visibility='pending' AND text!=''),0) AS pending FROM survey_responses WHERE survey_id=?").get(row.id);
    return { id: row.id, title: row.title, question: row.question, closed: !!row.closed, createdAt: row.created_at, responseCount: counts.total, pendingCount: counts.pending };
  };
  const publicSurvey = row => ({ id: row.id, title: row.title, question: row.question, closed: !!row.closed, createdAt: row.created_at });
  const responseRow = (surveyId, responseId) => {
    const row = db.prepare('SELECT * FROM survey_responses WHERE id=? AND survey_id=?').get(String(responseId), String(surveyId));
    if (!row) throw fault(404, 'response_not_found', 'This feedback could not be found');
    return row;
  };
  // A respondent can read only their own answer. Internal review fields never
  // cross the public boundary, including on an idempotent submission retry.
  const participantResponse = row => ({
    id: row.id, surveyId: row.survey_id, rating: row.rating, text: row.text,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const responseView = row => ({
    ...participantResponse(row),
    contactEmail: row.contact_email || null,
    // Keep legacy data intact while presenting its review state privately.
    visibility: row.visibility === 'published' ? 'reviewed' : row.visibility,
    status: row.status, reply: row.reply,
  });
  const session = (surveyId, value, required = true) => {
    const row = typeof value === 'string' && /^[\w-]{43}$/.test(value)
      ? db.prepare('SELECT participant,contact_email FROM survey_sessions WHERE token_hash=? AND survey_id=? AND expires_at>?').get(hash(value), String(surveyId), now()) : null;
    if (!row && required) throw fault(401, 'verification_required', 'Verify your email first');
    return row || null;
  };
  const openSurvey = surveyId => {
    const row = surveyRow(surveyId);
    if (row.closed) throw fault(409, 'survey_closed', 'This survey is closed');
    return row;
  };
  const rate = (bucket, max, windowMs) => {
    if (db.prepare('SELECT COUNT(*) AS n FROM survey_rate_events WHERE bucket=? AND created_at>?').get(bucket, now() - windowMs).n >= max) {
      throw fault(429, 'rate_limited', 'Too many requests. Please try again later');
    }
    db.prepare('INSERT INTO survey_rate_events VALUES (?,?)').run(bucket, now());
  };

  return {
    list() { return db.prepare('SELECT * FROM surveys ORDER BY created_at DESC, id').all().map(surveyView); },
    create(body = {}) {
      const title = plainText(body.title, { field: 'a survey title', max: 120, required: true });
      const question = plainText(body.question ?? 'How was your experience?', { field: 'a survey question', max: 240, required: true });
      const surveyId = id('srv');
      db.prepare('INSERT INTO surveys (id,title,question,created_at) VALUES (?,?,?,?)').run(surveyId, title, question, now());
      return surveyView(surveyRow(surveyId));
    },
    detail(surveyId) {
      const survey = surveyView(surveyRow(surveyId));
      const results = db.prepare('SELECT COUNT(*) AS total, AVG(rating) AS average FROM survey_responses WHERE survey_id=?').get(surveyId);
      const distribution = Array(5).fill(0);
      for (const row of db.prepare('SELECT rating,COUNT(*) AS n FROM survey_responses WHERE survey_id=? GROUP BY rating').all(surveyId)) distribution[row.rating - 1] = row.n;
      return { survey, results: { ...results, distribution }, responses: db.prepare('SELECT * FROM survey_responses WHERE survey_id=? ORDER BY created_at DESC,id').all(surveyId).map(row => responseView(row)) };
    },
    update(surveyId, patch = {}) {
      const row = surveyRow(surveyId);
      const title = patch.title === undefined ? row.title : plainText(patch.title, { field: 'a survey title', max: 120, required: true });
      const question = patch.question === undefined ? row.question : plainText(patch.question, { field: 'a survey question', max: 240, required: true });
      if (patch.closed !== undefined && typeof patch.closed !== 'boolean') throw fault(400, 'invalid_survey', 'Choose whether the survey is closed');
      db.prepare('UPDATE surveys SET title=?,question=?,closed=? WHERE id=?').run(title, question, patch.closed === undefined ? row.closed : Number(patch.closed), surveyId);
      return surveyView(surveyRow(surveyId));
    },
    moderate(surveyId, responseId, patch = {}) {
      surveyRow(surveyId);
      const row = responseRow(surveyId, responseId);
      // Redaction placeholders can expand a valid 2,000-character submission.
      const text = patch.text === undefined ? row.text : plainText(patch.text, { field: 'feedback', max: 20_000 });
      const reply = patch.reply === undefined ? row.reply : plainText(patch.reply, { field: 'a team note', max: 2000 });
      const visibility = patch.visibility ?? (row.visibility === 'published' ? 'reviewed' : row.visibility);
      const status = patch.status ?? row.status;
      if (!VISIBILITY.includes(visibility) || !STATUS.includes(status)) throw fault(400, 'invalid_survey', 'Choose a valid visibility and status');
      db.prepare('UPDATE survey_responses SET text=?,reply=?,visibility=?,status=?,updated_at=? WHERE id=?').run(text, reply, visibility, status, now(), row.id);
      return responseView(responseRow(surveyId, responseId));
    },
    removeResponse(surveyId, responseId) {
      surveyRow(surveyId); responseRow(surveyId, responseId);
      db.prepare('DELETE FROM survey_responses WHERE id=? AND survey_id=?').run(responseId, surveyId);
      return { ok: true };
    },
    publicView(surveyId, sessionToken) {
      const survey = publicSurvey(surveyRow(surveyId));
      const participant = session(surveyId, sessionToken, false)?.participant;
      const mine = participant && db.prepare('SELECT * FROM survey_responses WHERE survey_id=? AND participant=?').get(surveyId, participant);
      return { survey, verified: !!participant, mine: mine ? participantResponse(mine) : null };
    },
    async startVerification(surveyId, { email, ip = 'unknown', publicUrl, mailer } = {}) {
      surveyRow(surveyId);
      const clean = contactEmail(email);
      if (!clean) throw fault(400, 'email_invalid', 'Enter a valid email address');
      const url = surveyPublicUrl(publicUrl, surveyId);
      const magicToken = token();
      const tokenHash = hash(magicToken);
      const participant = opaque(`survey:${surveyId}:mailbox:${clean}`);
      transaction(() => {
        sweep();
        rate(opaque(`email:${clean}`), 5, MAGIC_TTL);
        rate(opaque(`ip:${String(ip)}`), 20, MAGIC_TTL);
        db.prepare('INSERT INTO survey_challenges (token_hash,survey_id,participant,expires_at,contact_email) VALUES (?,?,?,?,?)').run(tokenHash, surveyId, participant, now() + MAGIC_TTL, clean);
      });
      const link = `${url}#verify=${magicToken}`;
      try {
        await send({ to: clean, subject: 'Verify your email for Servant feedback', text: `Use this link to verify your email and submit private feedback: ${link}\n\nThis link expires in 10 minutes and works once. If you did not request it, ignore this email.`, url: link, minutes: 10 }, { mailer });
      } catch {
        db.prepare('DELETE FROM survey_challenges WHERE token_hash=?').run(tokenHash);
        throw fault(502, 'email_send_failed', 'The verification email could not be sent. Please try again later');
      }
      return { ok: true, expiresInSeconds: MAGIC_TTL / 1000 };
    },
    verify(surveyId, magicToken) {
      surveyRow(surveyId);
      if (typeof magicToken !== 'string' || !/^[\w-]{43}$/.test(magicToken)) throw fault(403, 'verification_expired', expiredLink);
      return transaction(() => {
        sweep();
        const challenge = db.prepare('SELECT * FROM survey_challenges WHERE token_hash=? AND survey_id=? AND expires_at>?').get(hash(magicToken), surveyId, now());
        if (!challenge) throw fault(403, 'verification_expired', expiredLink);
        const sessionToken = token();
        const expiresAt = now() + SESSION_TTL;
        db.prepare('DELETE FROM survey_challenges WHERE token_hash=?').run(challenge.token_hash);
        db.prepare('INSERT INTO survey_sessions (token_hash,survey_id,participant,expires_at,contact_email) VALUES (?,?,?,?,?)').run(hash(sessionToken), surveyId, challenge.participant, expiresAt, challenge.contact_email || null);
        return { token: sessionToken, expiresAt };
      });
    },
    async submit(surveyId, sessionToken, body = {}) {
      surveyId = String(surveyId);
      const participant = session(surveyId, sessionToken).participant;
      // Snapshot the request before inference; callers cannot change its values
      // while the local model is running.
      const rating = body.rating, requestId = body.requestId;
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fault(400, 'invalid_rating', 'Choose one of the five faces');
      const rawText = plainText(body.text ?? '', { field: 'feedback', max: 2000, allowPii: true });
      if (body.noPii !== true) throw fault(400, 'pii_confirmation_required', 'Confirm your feedback contains no personal information');
      if (typeof requestId !== 'string' || !/^[\w-]{8,100}$/.test(requestId)) throw fault(400, 'invalid_request', 'A response request ID is required');
      // Key the original payload, since different private values can redact to
      // identical text. No unredacted comment or reversible copy is persisted.
      const requestHash = 'hmac:' + opaque(JSON.stringify(['survey-response', surveyId, participant, rating, rawText]));
      const savedResponse = () => {
        surveyRow(surveyId);
        const previous = db.prepare('SELECT * FROM survey_responses WHERE survey_id=? AND participant=?').get(surveyId, participant);
        if (previous?.request_id === requestId) {
          // Older responses used a plain digest; preserve their retry contract.
          const expected = previous.request_hash.startsWith('hmac:') ? requestHash : hash(JSON.stringify([rating, rawText]));
          if (previous.request_hash !== expected) throw fault(409, 'request_conflict', 'This request already saved different feedback');
          return participantResponse(previous);
        }
        if (previous) throw fault(409, 'already_submitted', 'You have already responded to this survey');
        return null;
      };
      const saved = savedResponse();
      if (saved) return saved;
      openSurvey(surveyId);
      let text = '';
      if (rawText) {
        try {
          text = await redact(rawText);
          // Redaction placeholders can expand the original 2,000 characters.
          if (typeof text !== 'string' || text.length > 20_000 || hasSurveyPii(text)) throw new Error('Invalid redaction');
        } catch {
          throw fault(503, 'survey_pii_unavailable', 'Personal information could not be removed. Your response was not saved. Please try again later');
        }
      }
      // Never hold a SQLite transaction across inference. Recheck credentials,
      // duplicates and collection state together after the asynchronous work.
      return transaction(() => {
        const verified = session(surveyId, sessionToken);
        const saved = savedResponse();
        if (saved) return saved;
        openSurvey(surveyId);
        sweep();
        rate(`response:${participant}`, 5, 60 * 60_000);
        const responseId = id('rsp');
        // Only the verified session supplies the reply address. Body email fields
        // cannot substitute a different contact, including for legacy sessions.
        db.prepare(`INSERT INTO survey_responses (id,survey_id,participant,request_id,request_hash,rating,text,contact_email,visibility,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(responseId, surveyId, participant, requestId, requestHash, rating, text, verified.contact_email || null, text ? 'pending' : 'hidden', now(), now());
        return participantResponse(responseRow(surveyId, responseId));
      });
    },
    close() { db.close(); },
  };
}
