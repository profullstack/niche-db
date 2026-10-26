import { describe, expect, test } from 'bun:test';

/**
 * installSchedules runs on every boot of the web process and the worker. In
 * 2026-10 a BullMQ major removed the repeatable-job API it called, and because
 * neither the build nor the unit tests run startup code, the container
 * crash-looped in production. This drives the real function against a real
 * Redis, twice, the way two boots would.
 *
 * It runs in a child process: index.js opens its connection from REDIS_URL at
 * import, and config may already be loaded in this test process.
 */
const redisUrl = process.env.REDIS_TEST_URL;

const script = `
  const q = await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)});
  await q.installSchedules({ log: () => {} });
  await q.installSchedules({ log: () => {} });
  const out = {};
  for (const [name, queue] of Object.entries(q.queues)) {
    const s = await queue.getJobSchedulers();
    if (s.length) out[name] = s.map((x) => x.id ?? x.key).sort();
  }
  out.expected = q.scheduleSpecs().map(([, id]) => id).sort();
  console.log(JSON.stringify(out));
  await q.closeQueues();
`;

describe.skipIf(!redisUrl)('installSchedules with Redis', () => {
  test('boots twice and leaves exactly one scheduler per spec', async () => {
    const proc = Bun.spawn([process.execPath, '-e', script], {
      // config requires DATABASE_URL at import; nothing here connects to it.
      env: {
        DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
        ...process.env,
        REDIS_URL: redisUrl,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).not.toContain('is not a function');
    expect(code, stderr).toBe(0);
    const out = JSON.parse(stdout.trim().split('\n').at(-1));
    const { expected, ...installed } = out;
    expect(Object.values(installed).flat().sort()).toEqual(expected);
  }, 30_000);
});
