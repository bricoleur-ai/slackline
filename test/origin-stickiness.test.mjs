// Backfill can only tell self-vs-other; live ingest knows more (the outbound guard tells it
// whether OUR OWN message was typed by the human or posted by an agent). If a backfill can
// overwrite that, consumers filtering `origin=human,peer` silently stop seeing the operator's
// own messages — the exact failure the origin field exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../db.mjs';

for (const spec of ['memory', 'sqlite::memory:']) {
  test(`${spec}: backfill must not downgrade a live 'human' classification`, async () => {
    const s = createStore(spec); await s.init();
    await s.putMessage({ org: 'o', channel: 'c', ts: '1.1', user: 'U1', text: 'typed', origin: 'human', at: 1 });
    await s.putMessage({ org: 'o', channel: 'c', ts: '1.1', user: 'U1', text: 'typed', origin: 'hub', at: 1 });
    assert.equal((await s.recent('o', 'c', 1))[0].origin, 'human');
  });

  test(`${spec}: 'hub' stays sticky (pre-existing guarantee)`, async () => {
    const s = createStore(spec); await s.init();
    await s.putMessage({ org: 'o', channel: 'c', ts: '2.1', user: 'U1', text: 'agent post', origin: 'hub', at: 2 });
    await s.putMessage({ org: 'o', channel: 'c', ts: '2.1', user: 'U1', text: 'agent post', origin: 'peer', at: 2 });
    assert.equal((await s.recent('o', 'c', 1))[0].origin, 'hub');
  });

  test(`${spec}: a 'peer' row is still updatable — only OUR-OWN classifications are protected`, async () => {
    const s = createStore(spec); await s.init();
    await s.putMessage({ org: 'o', channel: 'c', ts: '3.1', user: 'U2', text: 'someone else', origin: 'peer', at: 3 });
    await s.putMessage({ org: 'o', channel: 'c', ts: '3.1', user: 'U2', text: 'someone else', origin: 'hub', at: 3 });
    assert.equal((await s.recent('o', 'c', 1))[0].origin, 'hub');
  });

  test(`${spec}: an omitted origin never clears an existing one`, async () => {
    const s = createStore(spec); await s.init();
    await s.putMessage({ org: 'o', channel: 'c', ts: '4.1', user: 'U2', text: 'x', origin: 'peer', at: 4 });
    await s.putMessage({ org: 'o', channel: 'c', ts: '4.1', user: 'U2', text: 'x edited', at: 4 });
    assert.equal((await s.recent('o', 'c', 1))[0].origin, 'peer');
  });
}
