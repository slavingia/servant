// 2,000 messages in #general from two people over 40 days: plain lines, longer paragraphs, formatting, links.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const conv = db.prepare("SELECT id FROM conversations WHERE name = 'general'").get().id;
const users = db.prepare('SELECT user_id FROM members WHERE conversation_id = ?').all(conv).map(r => r.user_id);
const lines = [
  'Morning. Two requests came in overnight.', 'Can someone check the intake form before the review?', 'Done. It went live this morning.',
  'The **permit renewals** were approved on Friday, and the notice goes out _today_.',
  'Notes from the call:\n- the form needs a field for the parcel number\n- the letter template is out of date\n- training is on Thursday',
  'I looked at the queue again. Most of what is waiting is from last month, and about a third of it is missing a document. I will write to those people today and ask for what is missing, then sort the rest by date so the oldest are seen first.',
  'See https://www.example.gov/guidance/intake for the guidance.', 'Thanks!', '`status = "received"` is what the export uses.', '> Is the form ready?\n\nYes, since this morning',
  'Agreed.', 'Who is covering the front desk on Monday?', 'I can take it until noon.', 'The budget review moved to Tuesday at ten.',
];
const insert = db.prepare('INSERT INTO messages (conversation_id, user_id, text, created_at) VALUES (?, ?, ?, ?)');
const start = Date.now() - 40 * 86400000;
db.exec('BEGIN');
for (let i = 0; i < 2000; i++) insert.run(conv, users[(i * 7 + (i >> 2)) % 2], `${lines[i % lines.length]} (${i + 1})`, start + i * 1700000);
db.exec('COMMIT');
const last = db.prepare('SELECT MAX(seq) AS seq FROM messages WHERE conversation_id = ?').get(conv).seq;
db.prepare('UPDATE members SET last_read_seq = ? WHERE conversation_id = ?').run(last, conv);
console.log('seeded', db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv).n, 'messages in', conv);
