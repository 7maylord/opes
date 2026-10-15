await import(
  process.env.OPES_PROCESS === 'worker'
    ? '../dist/worker.js'
    : '../dist/main.js'
);
