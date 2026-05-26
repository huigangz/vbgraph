import { defineConfig } from 'vitest/config';
import * as os from 'os';

// Cap worker concurrency to keep memory pressure bounded on Windows.
// The default vitest threads pool can spawn N=cpuCount workers each holding
// a SQLite connection + tree-sitter wasm grammars; on dev boxes with 16+
// logical cores the resident set grows past the worker-pool ceiling and the
// node-sqlite3-wasm backend (used when better-sqlite3 isn't installed)
// pushes it over. Documented in every P2 worklog as "full-batch hits
// Windows worker-pool OOM; runs individually". Forks pool is heavier per
// worker but isolates each test file's allocations, which is what the
// suite actually needs.
//
// Cap at 2: empirically the right balance on this codebase — bounded enough
// to avoid the OOM, low enough that latent test-isolation issues in
// resolution.test.ts (re-export chain following) don't surface under the
// heavy-parallel reordering vitest does at higher cap. Override via env
// `CODEGRAPH_TEST_MAX_FORKS` when running on machines with more headroom.
const ENV_CAP = parseInt(process.env.CODEGRAPH_TEST_MAX_FORKS ?? '', 10);
const POOL_CAP = Number.isFinite(ENV_CAP) && ENV_CAP > 0
  ? ENV_CAP
  : Math.min(os.cpus()?.length ?? 2, 2);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: POOL_CAP,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
