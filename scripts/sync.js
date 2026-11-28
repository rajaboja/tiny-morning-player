import { createStore } from '../lib/db.js';
import { parseSyncArgs, syncDatabase } from '../lib/sync.js';

async function main() {
  const opts = parseSyncArgs(process.argv.slice(2));

  if (opts.requireRemote && !process.env.TURSO_DATABASE_URL) {
    console.error('TURSO_DATABASE_URL is required when running with --require-remote');
    process.exit(1);
  }

  const store = createStore();
  try {
    const summary = await syncDatabase(store, {
      full: opts.full,
      maxPages: opts.maxPages,
      recentDays: opts.recentDays,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.tracksAttempted > 0 && summary.tracksFetched === 0 && summary.errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
