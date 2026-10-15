if (process.env.OPES_PROCESS !== 'worker') await import('./migrate.mjs');
