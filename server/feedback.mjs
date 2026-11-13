// Durable, serial inbox for in-app feedback. Reports are data, never executable commands: each one becomes a GitHub
// issue (fileIssue below) for a person to triage. No AI reads or acts on them.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export function createFeedback({ file, run, interval = 15000, recover = true }) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, requestId TEXT NOT NULL,
    text TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    result TEXT, createdAt INTEGER NOT NULL, UNIQUE(userId, requestId)
  )`);
  // One optional screenshot per report, kept as JSON [{name,mime,data(base64)}].
  if (!db.prepare("PRAGMA table_info(feedback)").all().some(c => c.name === 'images')) db.exec("ALTER TABLE feedback ADD COLUMN images TEXT");
  // If the server restarted mid-send, the issue may already exist; fileIssue looks for it before creating another.
  if (recover) db.exec("UPDATE feedback SET status='interrupted', result='The server restarted while sending this report. Retry to send it again.' WHERE status='working'");
  let busy = false, closed = false;
  const images = r => (r.images ? JSON.parse(r.images) : []);
  const view = r => ({ id: r.id, text: r.text, context: JSON.parse(r.context), status: r.status, result: r.result, createdAt: r.createdAt, screenshots: images(r).length });
  // The worker also gets the image bytes; clients only see the count.
  const work = r => ({ ...view(r), images: images(r).map(i => ({ name: i.name, mime: i.mime, data: Buffer.from(i.data, 'base64') })) });
  async function tick() {
    if (busy || closed) return;
    const row = db.prepare("SELECT * FROM feedback WHERE status='queued' ORDER BY createdAt LIMIT 1").get();
    if (!row) return;
    busy = true;
    db.prepare("UPDATE feedback SET status='working' WHERE id=?").run(row.id);
    try {
      const result = await run(work(row));
      if (!closed) db.prepare('UPDATE feedback SET status=?, result=? WHERE id=?').run(result.status, result.summary, row.id);
    } catch {
      if (!closed) db.prepare("UPDATE feedback SET status='interrupted', result=? WHERE id=?").run('Could not send this report to the team just now. It is saved; retry to send it again.k its previous work.', row.id);
    } finally { busy = false; }
  }
  const timer = interval ? setInterval(() => void tick(), interval) : null; timer?.unref();
  return {
    submit(userId, body, screenshots = []) {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 4000 || !/^[\w-]{8,100}$/.test(body.requestId || '')) throw Object.assign(new Error('Enter feedback (up to 4,000 characters)'), { status: 400, code: 'invalid_feedback' });
      const previous = db.prepare('SELECT * FROM feedback WHERE userId=? AND requestId=?').get(userId, body.requestId);
      if (previous) return view(previous);
      if (db.prepare('SELECT count(*) AS n FROM feedback WHERE userId=? AND createdAt>?').get(userId, Date.now()-3600000).n >= 5) throw Object.assign(new Error('You can send five reports per hour. Please try again later.'), { status:429, code:'rate_limited' });
      const context = Object.fromEntries(['screen','platform','version','build','via'].map(k => [k, String(body.context?.[k] || '').slice(0,150)]));
      const id = 'fb_' + crypto.randomUUID();
      const stored = screenshots.slice(0, 1).map(a => ({ name: a.name, mime: a.mime, data: Buffer.from(a.data).toString('base64') }));
      db.prepare('INSERT INTO feedback (id,userId,requestId,text,context,createdAt,images) VALUES (?,?,?,?,?,?,?)').run(id,userId,body.requestId,text,JSON.stringify(context),Date.now(),stored.length ? JSON.stringify(stored) : null);
      return view(db.prepare('SELECT * FROM feedback WHERE id=?').get(id));
    },
    list: userId => db.prepare('SELECT * FROM feedback WHERE userId=? ORDER BY createdAt DESC LIMIT 30').all(userId).map(view),
    retry(userId,id) {
      db.prepare("UPDATE feedback SET status='queued', result=NULL WHERE id=? AND userId=? AND status='interrupted'").run(id,userId);
    },
    tick,
    close() { closed=true; if (timer) clearInterval(timer); db.close(); },
  };
}

// No AI is involved: a report becomes a GitHub issue for a person to triage. The reporter's words are only ever data:
// they go into a code fence (so @mentions, links and #refs in them do nothing) and are never run or interpreted.
const REPO = /^[\w.-]+\/[\w.-]+$/;
const longestRun = (text, ch) => Math.max(0, ...(text.match(new RegExp(`${ch}+`, 'g')) || []).map(r => r.length));

export function issueFor(report) {
  const text = String(report.text || '').trim();
  const firstLine = text.split('\n').find(l => l.trim()) || 'Feedback';
  // A title is plain text on one line; keep it short and free of characters GitHub turns into mentions or links.
  const title = ('Feedback: ' + firstLine.replace(/[@#`<>\[\]]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 90).trim();
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  const ctx = report.context || {};
  const lines = ['screen', 'platform', 'version', 'build', 'via'].filter(k => ctx[k]).map(k => `- ${k}: \`${String(ctx[k]).replace(/`/g, "'")}\``);
  const body = [
    'Sent from the Servant app. The text below is exactly what the reporter wrote, so treat it as untrusted.',
    '', fence, text, fence, '',
    lines.length ? lines.join('\n') : '- no context',
    report.images?.length ? '- a screenshot was attached in the app (kept on the server, not uploaded here)' : '',
    '', `Report ${report.id}`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return { title: title || 'Feedback', body };
}

/**
 * Create the issue with the server owner's gh login. `exec(args, input)` runs gh and resolves stdout (injectable for
 * tests). A report already filed (this id is in an issue body) is found again instead of filed twice, so a retry after
 * a lost connection can't duplicate it.
 */
export async function fileIssue(report, { repo, exec }) {
  if (!REPO.test(repo || '') || repo.split('/').some(p => /^\.+$/.test(p))) throw Object.assign(new Error('No feedback repository is set up'), { status: 503 });
  const found = JSON.parse(await exec(['issue', 'list', '-R', repo, '--state', 'all', '--search', `"${report.id}" in:body`, '--json', 'number,url', '--limit', '1']).catch(() => '[]') || '[]');
  let issue = found[0];
  if (!issue) {
    const { title, body } = issueFor(report);
    const make = labels => exec(['issue', 'create', '-R', repo, '--title', title, '--body-file', '-', ...labels], body);
    const out = await make(['--label', 'feedback']).catch(() => make([]));
    const url = String(out).trim().split('\n').pop();
    issue = { url, number: Number((url.match(/\/issues\/(\d+)/) || [])[1]) || undefined };
  }
  return { status: 'filed', summary: issue.number ? `Sent to the team as issue #${issue.number}.` : 'Sent to the team.' };
}
