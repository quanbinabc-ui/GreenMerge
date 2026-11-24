import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createConfiguredBackend } from '../src/bootstrap/configured.js';
import { createDatabasePool } from '../src/database/pool.js';
import { createLocalStorage } from '../src/storage/local.js';
import { createSupabaseStorage } from '../src/storage/supabase.js';
import { createPostgresRepository } from '../src/repositories/postgres.js';
import { cleanupExpiredPendingReports } from '../src/maintenance/cleanup.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
config({ path: path.join(root, 'apps/api/.env'), quiet: true });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const hoursArg = args.find(item => item.startsWith('--hours='))?.slice('--hours='.length);
const olderThanHours = hoursArg !== undefined ? Number(hoursArg) : 48;

if (!Number.isFinite(olderThanHours) || olderThanHours <= 0) {
  console.error('Invalid --hours value; expected a positive number.');
  process.exitCode = 1;
} else {
  const persistence = process.env.PERSISTENCE_MODE ?? 'memory';
  if (persistence !== 'postgres') {
    console.error('maintenance:cleanup requires PERSISTENCE_MODE=postgres. Memory repositories reset on restart.');
    process.exitCode = 1;
  } else {
    const pool = createDatabasePool(process.env);
    try {
      const storageMode = process.env.STORAGE_PROVIDER ?? 'local';
      const storage = storageMode === 'supabase'
        ? createSupabaseStorage({
          url: process.env.SUPABASE_URL ?? '',
          secretKey: process.env.SUPABASE_SECRET_KEY ?? '',
          bucket: process.env.SUPABASE_STORAGE_BUCKET ?? '',
          prefix: process.env.SUPABASE_STORAGE_PREFIX,
        })
        : createLocalStorage(
          path.resolve(process.env.UPLOAD_DIR || path.join(root, '.runtime/uploads')),
          process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000',
        );
      // Verify configured backend types remain aligned without starting HTTP listener.
      void createConfiguredBackend;
      const result = await cleanupExpiredPendingReports({
        repository: createPostgresRepository(pool),
        storage,
        olderThanHours,
        dryRun: !apply,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Cleanup failed.');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
