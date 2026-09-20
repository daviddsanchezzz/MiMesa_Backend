// In-process mutex per key. Serialises check-then-write sections (e.g. capacity checks)
// so concurrent requests on the same key can't both pass the check. Single-instance only.
const tails = new Map();

async function acquireLock(key) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  await previous;
  return () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

function serializeBy(keyFn, handler) {
  return async (req, res, next) => {
    const release = await acquireLock(keyFn(req));
    try {
      return await handler(req, res, next);
    } finally {
      release();
    }
  };
}

module.exports = { acquireLock, serializeBy };
