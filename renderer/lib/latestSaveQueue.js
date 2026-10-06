/**
 * Keep one editor save in flight and retain only the newest draft behind it.
 * The server still receives every completed latest draft, in order, while a
 * burst of local edits cannot let an older response replace newer state.
 */
export function createLatestSaveQueue({ persist, initialRevision = null, onStart, onSuccess, onError }) {
  let pending = null;
  let running = false;
  let active = null;
  let lastCompleted = null;
  let revision = initialRevision;
  let waiters = [];

  function latestWaiterValue() {
    let latest = null;
    for (const waiter of waiters) {
      const value = typeof waiter.value === 'function' ? waiter.value() : waiter.value;
      if (value && value !== active && value !== lastCompleted) latest = value;
    }
    return latest;
  }

  async function drain() {
    running = true;
    let lastError = null;
    while (pending || waiters.length) {
      // A live flush owns the latest draft, including cancellation after an
      // acknowledgment; its older queued snapshot must not win the next write.
      if (waiters.some((waiter) => typeof waiter.value === 'function') || !pending) pending = latestWaiterValue();
      if (!pending) break;
      const value = pending;
      pending = null;
      active = value;
      onStart?.(value);
      try {
        const row = await persist(value, revision);
        revision = row?.updatedAt ?? revision;
        lastError = null;
        active = null;
        lastCompleted = value;
        onSuccess?.(row, value);
      } catch (error) {
        lastError = error;
        active = null;
        pending = null;
        onError?.(error, value);
        break;
      }
    }
    running = false;
    const settled = waiters;
    waiters = [];
    for (const waiter of settled) {
      if (lastError) waiter.reject(lastError);
      else waiter.resolve();
    }
  }

  return {
    enqueue(value) {
      if (!value) return;
      if (active === value && pending == null) return;
      if (pending === value) return;
      pending = value;
      if (!running) void drain();
    },
    flush(value) {
      const current = typeof value === 'function' ? value() : value;
      if (current && active !== current && pending !== current && lastCompleted !== current) pending = current;
      const latest = typeof value === 'function' ? value : null;
      const promise = new Promise((resolve, reject) => waiters.push({ resolve, reject, value: latest }));
      if (!running) void drain();
      return promise;
    },
    setRevision(value) {
      revision = value;
    },
    hasPending() {
      return running || !!pending;
    },
  };
}
