/** Keep public pages available while one request refreshes their cached HTML. */
export function pageCache(redis, { onError = console.error } = {}) {
  const pending = new Map();
  function refresh(key, produce, ttl) {
    if (pending.has(key)) return pending.get(key);
    const work = Promise.resolve()
      .then(produce)
      .then(async (body) => {
        try {
          await redis.set(`page:${key}:stale`, body, 'EX', Math.max(ttl * 10, 3600));
          await redis.set(`page:${key}`, body, 'EX', ttl);
        } catch {}
        return body;
      })
      .finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }
  return async (key, produce, ttl) => {
    try {
      const hit = await redis.get(`page:${key}`);
      if (hit) return { body: hit, status: 'hit' };
      const stale = await redis.get(`page:${key}:stale`);
      if (stale) {
        refresh(key, produce, ttl).catch(onError);
        return { body: stale, status: 'stale' };
      }
    } catch {}
    return { body: await refresh(key, produce, ttl), status: 'miss' };
  };
}
