// Counting semaphore. Each render holds a Chromium page and possibly a preview
// process, so unbounded concurrency is how a self-hosted box runs out of memory.
export const createSemaphore = (limit) => {
  let active = 0;
  const waiters = [];

  const release = () => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  const acquire = () =>
    new Promise((resolve) => {
      const grant = () => {
        active += 1;
        resolve();
      };
      if (active < limit) grant();
      else waiters.push(grant);
    });

  return {
    run: async (task) => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get pending() {
      return waiters.length;
    },
    get active() {
      return active;
    },
  };
};
