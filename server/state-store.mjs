// Transactional account/device/invite/chat metadata. The API and CLI share one
// store; mutation callbacks must be synchronous and must never do network work.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 1;
const COLLECTIONS = ['users', 'devices', 'invites', 'chats'];
const emptyState = () => Object.fromEntries(COLLECTIONS.map(name => [name, {}]));
const object = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function validate(value) {
  if (!object(value) || Object.keys(value).length !== COLLECTIONS.length ||
      COLLECTIONS.some(name => !Object.hasOwn(value, name) || !object(value[name]))) {
    throw new Error('Invalid state: expected users, devices, invites and chats maps');
  }
  for (const name of COLLECTIONS) {
    if (Object.values(value[name]).some(record => !object(record))) {
      throw new Error(`Invalid state: ${name} entries must be objects`);
    }
  }
  // JSON.stringify would otherwise silently drop undefined/function values or
  // turn non-finite numbers into null. Reject such mutations instead.
  const seen = new Set();
  function visit(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if ((!Array.isArray(item) && !object(item)) || seen.has(item)) {
      throw new Error('Invalid state: values must be finite, acyclic JSON data');
    }
    seen.add(item);
    for (const child of Object.values(item)) visit(child);
    seen.delete(item);
  }
  visit(value);
  return value;
}

function parse(payload) {
  let value;
  try { value = JSON.parse(payload); }
  catch { throw new Error('Invalid state: unreadable JSON; refusing to reset accounts'); }
  return validate(value);
}

function privateFiles(operation) {
  // All SQLite operations here are synchronous. Restore the process's mask
  // before returning so importing consumers do not inherit a changed default.
  const previous = process.umask(0o077);
  try { return operation(); }
  finally { process.umask(previous); }
}

export function createStateStore({ directory }) {
  if (typeof directory !== 'string' || !directory) throw new Error('State directory is required');
  const file = path.join(directory, 'state.db');
  let db;
  try {
    privateFiles(() => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Restrict an existing database too, before SQLite can create WAL files.
      const descriptor = fs.openSync(file, 'a', 0o600);
      try { fs.fchmodSync(descriptor, 0o600); }
      finally { fs.closeSync(descriptor); }
      db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout=5000');
      // Concurrent first opens can race the journal-mode transition. SQLite
      // sometimes returns BUSY immediately here despite busy_timeout.
      const deadline = Date.now() + 5000;
      for (;;) {
        try { db.exec('PRAGMA journal_mode=WAL'); break; }
        catch (error) {
          if (![5, 6].includes(error.errcode) || Date.now() >= deadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      db.exec('PRAGMA synchronous=FULL');
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.chmodSync(file + suffix, 0o600); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (version === 0) {
          const tables = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
          if (tables.length) throw new Error('Unrecognized state database; refusing to overwrite it');
          let initial;
          try { initial = parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; initial = emptyState(); }
          db.exec(`CREATE TABLE state_document (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL,
            payload TEXT NOT NULL
          )`);
          db.prepare('INSERT INTO state_document VALUES (1, ?, ?)').run(VERSION, JSON.stringify(initial));
          db.exec(`PRAGMA user_version=${VERSION}`);
        } else if (version !== VERSION) {
          throw new Error(`Unsupported state database version ${version}`);
        }
        // A missing or malformed initialized record is corruption, not a new
        // install. Never fall back to the stale legacy snapshot in that case.
        readDocument();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  } catch (error) {
    db?.close();
    throw error;
  }

  let closed = false;
  let mutating = false;
  // Reads are hot (every request reads the document several times). Parsing and validating the whole document each
  // time cost most of the server's CPU, so the last committed document is kept, frozen, until this connection commits
  // or SQLite's data_version says another connection (the CLI, another process) did. Callers get a read-only view;
  // changes go through mutate(), which always works on a fresh copy.
  let cached = null;
  let cachedVersion = null;
  const dataVersion = () => db.prepare('PRAGMA data_version').get().data_version;
  const deepFreeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  function readDocument() {
    if (db.prepare('PRAGMA user_version').get().user_version !== VERSION) {
      throw new Error('Unsupported state database version');
    }
    const row = db.prepare('SELECT version, payload FROM state_document WHERE id = 1').get();
    if (!row || row.version !== VERSION) throw new Error('Invalid or unsupported state document');
    return parse(row.payload);
  }
  function read() {
    if (closed) throw new Error('State store is closed');
    const version = dataVersion();
    if (cached && version === cachedVersion) return cached;
    cached = deepFreeze(readDocument());
    cachedVersion = version;
    return cached;
  }
  function mutate(fn) {
    if (closed) throw new Error('State store is closed');
    if (mutating) throw new Error('Nested state mutations are not supported');
    if (typeof fn !== 'function') throw new Error('State mutation requires a synchronous callback');
    return privateFiles(() => {
      db.exec('BEGIN IMMEDIATE');
      mutating = true;
      try {
        const current = readDocument();
        const result = fn(current);
        if (result && typeof result.then === 'function') {
          // Consume rejection from an accidentally async callback. Its detached
          // snapshot cannot be persisted after this transaction rolls back.
          Promise.resolve(result).catch(() => {});
          throw new Error('State mutation callbacks must be synchronous');
        }
        validate(current);
        db.prepare('UPDATE state_document SET payload = ? WHERE id = 1').run(JSON.stringify(current));
        db.exec('COMMIT');
        cached = null;
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally { mutating = false; }
    });
  }
  function close() {
    if (mutating) throw new Error('Cannot close state store during a mutation');
    if (closed) return;
    db.close();
    closed = true;
  }
  return { read, mutate, close };
}
