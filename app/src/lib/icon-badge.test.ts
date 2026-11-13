import test from 'node:test';
import assert from 'node:assert/strict';
import { createIconBadgeSync, createIconBadgeWriter, loadIconBadge } from './icon-badge.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('iOS foreground and receipt refreshes clear a stale icon 1 even when inbox zero is unchanged', async () => {
  let icon = 1;
  let loads = 0;
  const written: number[] = [];
  const sync = createIconBadgeSync({
    load: async () => { loads++; return loadIconBadge(async () => [], async () => []); },
    setBadge: createIconBadgeWriter('ios', async count => { written.push(count); icon = count; }), active: () => true,
  });
  await sync.refresh();
  assert.equal(icon, 0);
  icon = 1; // A delayed push changes the native badge independently of React.
  await sync.refresh();
  assert.equal(icon, 0);
  assert.deepEqual(written, [0, 0]);
  assert.equal(loads, 2);
  sync.dispose();
});

test('Android receipt and repeated zero refreshes preserve a newly presented agent notification', async () => {
  const pendingLoad = deferred<void>();
  const started = deferred<void>();
  const cards = new Set(['existing-notification']);
  const written: number[] = [];
  let loads = 0;
  const sync = createIconBadgeSync({
    load: async () => {
      if (++loads === 1) { started.resolve(); await pendingLoad.promise; }
      // The deployed /v1/chats API omits unread even for a newly answered chat.
      return loadIconBadge(async () => [], async () => [{}]);
    },
    setBadge: createIconBadgeWriter('android', async count => {
      written.push(count);
      if (count === 0) cards.clear(); // Expo Android calls NotificationManager.cancelAll().
    }), active: () => true,
  });
  const receipt = sync.refresh();
  await started.promise;
  cards.add('new-agent-reply'); // Native presentation wins the race with the fetch.
  pendingLoad.resolve();
  await receipt;
  await sync.refresh();
  await sync.refresh(0);
  assert.equal(loads, 2);
  assert.deepEqual(written, []);
  assert.deepEqual([...cards], ['existing-notification', 'new-agent-reply']);
  sync.dispose();
});

test('Android positive badge updates still apply without dismissing notification cards', async () => {
  const cards = new Set(['unread-message']);
  const written: number[] = [];
  const sync = createIconBadgeSync({
    load: () => loadIconBadge(async () => [{ unread: 2 }], async () => []),
    setBadge: createIconBadgeWriter('android', async count => {
      written.push(count);
      if (count === 0) cards.clear();
    }), active: () => true,
  });
  await sync.refresh();
  await sync.refresh(3);
  assert.deepEqual(written, [2, 3]);
  assert.deepEqual([...cards], ['unread-message']);
  sync.dispose();
});

test('badge totals sum reported counts, exclude archived conversations, and tolerate unavailable legacy agent counts', async () => {
  assert.equal(await loadIconBadge(async () => [
    { unread: 2 }, { unread: 3, archived: false }, { unread: 90, archived: true },
  ], async () => [{ unread: 4 }, {}, { unread: 0 }]), 9);
});

test('failed or incomplete inbox loads preserve the current badge', async () => {
  const incomplete = undefined as unknown as { unread: number }[];
  const scenarios = [
    () => loadIconBadge(async () => { throw new Error('offline'); }, async () => []),
    () => loadIconBadge(async () => [], async () => { throw new Error('offline'); }),
    () => loadIconBadge(async () => incomplete, async () => []),
    () => loadIconBadge(async () => [], async () => incomplete),
    () => loadIconBadge(async () => [{}], async () => []),
    () => loadIconBadge(async () => [{ unread: -1 }], async () => []),
    () => loadIconBadge(async () => [], async () => [{ unread: NaN }]),
  ];
  for (const load of scenarios) {
    const written: number[] = [];
    const sync = createIconBadgeSync({ load, setBadge: async count => { written.push(count); }, active: () => true });
    await sync.refresh();
    assert.deepEqual(written, [], 'an unavailable or invalid snapshot must not clear the icon');
    sync.dispose();
  }
});

test('a failed refresh can repair the badge after the network recovers', async () => {
  let offline = true;
  const written: number[] = [];
  const sync = createIconBadgeSync({ load: async () => {
    if (offline) throw new Error('offline');
    return 0;
  }, setBadge: async count => { written.push(count); }, active: () => true });
  await sync.refresh();
  assert.deepEqual(written, []);
  offline = false;
  await sync.refresh();
  assert.deepEqual(written, [0]);
  sync.dispose();
});

test('a newer refresh discards an old unread snapshot and reloads before writing', async () => {
  const old = deferred<number>();
  const started = deferred<void>();
  let loads = 0;
  const written: number[] = [];
  const sync = createIconBadgeSync({ load: async () => {
    if (++loads === 1) { started.resolve(); return old.promise; }
    return 0;
  }, setBadge: async count => { written.push(count); }, active: () => true });
  const pending = sync.refresh();
  await started.promise;
  const refreshed = sync.refresh();
  old.resolve(1);
  await Promise.all([pending, refreshed]);
  assert.deepEqual(written, [0]);
  assert.equal(loads, 2);
  sync.dispose();
});

test('a supplied authoritative zero supersedes an in-flight snapshot without another load', async () => {
  const old = deferred<number>();
  const started = deferred<void>();
  let loads = 0;
  const written: number[] = [];
  const sync = createIconBadgeSync({ load: async () => {
    loads++; started.resolve(); return old.promise;
  }, setBadge: async count => { written.push(count); }, active: () => true });
  const pending = sync.refresh();
  await started.promise;
  const authoritative = sync.refresh(0);
  old.resolve(1);
  await Promise.all([pending, authoritative]);
  assert.deepEqual(written, [0]);
  assert.equal(loads, 1);
  sync.dispose();
});

test('backgrounding rejects a late snapshot, and resuming fetches a fresh count', async () => {
  const old = deferred<number>();
  const started = deferred<void>();
  let active = false;
  let loads = 0;
  const written: number[] = [];
  const sync = createIconBadgeSync({ load: async () => {
    if (++loads === 1) { started.resolve(); return old.promise; }
    return 2;
  }, setBadge: async count => { written.push(count); }, active: () => active });
  await sync.refresh();
  assert.equal(loads, 0);
  active = true;
  const pending = sync.refresh();
  await started.promise;
  active = false;
  old.resolve(0);
  await pending;
  assert.deepEqual(written, []);
  active = true;
  await sync.refresh();
  assert.deepEqual(written, [2]);
  sync.dispose();
});

test('account disposal aborts its load and prevents old work overwriting the next account badge', async () => {
  const old = deferred<number>();
  const started = deferred<AbortSignal>();
  const written: number[] = [];
  const first = createIconBadgeSync({ load: signal => { started.resolve(signal); return old.promise; },
    setBadge: async count => { written.push(count); }, active: () => true });
  const pending = first.refresh();
  const signal = await started.promise;
  first.dispose();
  assert.equal(signal.aborted, true);
  const next = createIconBadgeSync({ load: async () => 3,
    setBadge: async count => { written.push(count); }, active: () => true });
  await next.refresh();
  old.resolve(0);
  await pending;
  await first.refresh(1);
  assert.deepEqual(written, [3]);
  next.dispose();
});

test('badge writes are serialized so a slower earlier write cannot win over the latest count', async () => {
  const firstWrite = deferred<void>();
  const started = deferred<void>();
  let concurrent = 0;
  let maximum = 0;
  let icon = -1;
  const written: number[] = [];
  const sync = createIconBadgeSync({ load: async () => 0, active: () => true,
    setBadge: async count => {
      maximum = Math.max(maximum, ++concurrent);
      if (count === 1) { started.resolve(); await firstWrite.promise; }
      icon = count; written.push(count); concurrent--;
    },
  });
  const pending = sync.refresh(1);
  await started.promise;
  const latest = sync.refresh(0);
  assert.equal(concurrent, 1);
  firstWrite.resolve();
  await Promise.all([pending, latest]);
  assert.equal(maximum, 1);
  assert.equal(icon, 0);
  assert.deepEqual(written, [1, 0]);
  sync.dispose();
});

test('a refresh queued as a write finishes is not lost during cleanup', async () => {
  const written: number[] = [];
  const sync = createIconBadgeSync({ load: async () => 0, active: () => true,
    setBadge: async count => {
      written.push(count);
      if (count === 1) queueMicrotask(() => queueMicrotask(() => { void sync.refresh(0); }));
    },
  });
  await sync.refresh(1);
  assert.deepEqual(written, [1, 0]);
  sync.dispose();
});
