import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // SQLite integration suites share disk bandwidth, including a million-row
    // archive fixture. Bound contention so their wall-clock deadlines stay useful.
    maxWorkers: 2,
  },
});
