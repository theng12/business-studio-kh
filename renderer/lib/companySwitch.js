const flushers = new Set();

export function registerCompanySwitchFlusher(flush) {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

export async function flushCompanySwitches() {
  await Promise.all([...flushers].map((flush) => flush()));
}
