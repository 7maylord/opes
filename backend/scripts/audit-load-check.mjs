import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { DatabaseService } from '../dist/core/database/database.service.js';
import { readBoundedJson } from '../dist/infrastructure/evm/bounded-json.js';

// Never point concurrency/failure injection at the application database.
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.pathname, '/opes_audit');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.ok(global.gc, 'Run with node --expose-gc');
const db = new DatabaseService();
const report = { queries: 0, rejected: 0, maxConnections: 0, maxWaiting: 0 };
let sampler;
try {
  await db.withDatabase(sql => sql.query('SELECT 1'));
  sampler = setInterval(() => {
    report.maxConnections = Math.max(report.maxConnections, db.pool.totalCount);
    report.maxWaiting = Math.max(report.maxWaiting, db.pool.waitingCount);
  }, 2);
  for (let round = 0; round < 5; round++) {
    const results = await Promise.allSettled(Array.from({length:500}, () => db.withDatabase(sql => sql.query('SELECT pg_sleep(0.002)'))));
    for (const result of results) {
      if (result.status === 'fulfilled') report.queries++;
      else { assert.equal(result.reason.getStatus?.(), 503); report.rejected++; }
    }
    assert.equal(db.pool.waitingCount, 0);
    assert.equal(db.waiting, 0);
  }
  assert.ok(report.maxConnections <= 10);
  assert.ok(report.maxWaiting <= 100);
  assert.ok(report.rejected > 0);

  const held = await Promise.all(Array.from({length:10}, () => db.pool.connect()));
  const start = performance.now();
  try {
    await assert.rejects(db.withDatabase(sql => sql.query('SELECT 1')), /timeout/);
    report.acquireTimeoutMs = Math.round(performance.now() - start);
    assert.ok(report.acquireTimeoutMs < 6500);
  } finally { held.forEach(client => client.release()); }
  assert.equal(db.pool.waitingCount, 0);

  // Kill our own idle connection: the error must be handled and replaced.
  const idle = await db.withDatabase(sql => sql.query('SELECT pg_backend_pid() AS pid'));
  const killer = new pg.Client({connectionString:process.env.DATABASE_URL});
  await killer.connect();
  try {
    const lost = new Promise(resolve => db.pool.once('error', resolve));
    await killer.query('SELECT pg_terminate_backend($1)', [idle.rows[0].pid]);
    await Promise.race([lost, delay(5000).then(() => { throw new Error('Idle error was not observed'); })]);
    await db.withDatabase(sql => sql.query('SELECT 1'));
    report.idleDisconnectRecovered = true;
  } finally { await killer.end(); }

  const valid = JSON.stringify({value:'x'.repeat(1024 * 1024)});
  for(let warmup=0;warmup<20;warmup++) await readBoundedJson(new Response(valid));
  global.gc();
  const before = process.memoryUsage();
  for(let round=0;round<100;round++) {
    const chunk = new Uint8Array(64 * 1024);
    let cancelled = false;
    const stream = new ReadableStream({pull(controller){controller.enqueue(chunk);},cancel(){cancelled=true;}});
    await assert.rejects(readBoundedJson(new Response(stream)), /too large/);
    assert.equal(cancelled, true);
    await readBoundedJson(new Response(valid));
  }
  await delay(50);
  global.gc();
  const after = process.memoryUsage();
  report.heapGrowthBytes = after.heapUsed-before.heapUsed;
  report.rssBytes = after.rss;
  assert.ok(report.heapGrowthBytes < 16 * 1024 * 1024, 'Bounded response loop retained more than 16 MiB');
} finally {
  clearInterval(sampler);
  await db.onModuleDestroy();
}
await assert.rejects(db.withDatabase(sql => sql.query('SELECT 1')), /busy/);
console.log(JSON.stringify(report, null, 2));
