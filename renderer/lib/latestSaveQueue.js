/**
 * Keep one editor save in flight and retain only the newest draft behind it.
 * The server still receives every completed latest draft, in order, while a
 * burst of local edits cannot let an older response replace newer state.
 */
export function createLatestSaveQueue({ persist, onStart, onSuccess, onError }) {
  let pending = null;
  let running = false;
  let active = null;
  let waiters = [];

  async function drain() {
    running = true;
    let lastError = null;
    while (pending) {
      const value = pending;
      pending = null;
      active = value;
      onStart?.(value);
      try {
        const row = await persist(value);
        lastError = null;
        active = null;
        if (!pending) onSuccess?.(row, value);
      } catch (error) {
        lastError = error;
        active = null;
        onError?.(error, value);
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
      if (value && active !== value) pending = value;
      const promise = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      if (!running) void drain();
      return promise;
    },
    hasPending() {
      return running || !!pending;
    },
  };
}
