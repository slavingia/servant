// Send one email through the owner's approved mailer command.
import { spawn } from 'node:child_process';

// Values are JSON on stdin, never shell arguments; provider stderr is deliberately not logged or exposed.
export function mailerSender(message, settings = {}) {
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
