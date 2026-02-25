import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/property/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types/**/*.ts'],
    },
    globals: false,
    environment: 'node',
    // code-chunker loads @babel/parser which is memory-heavy (~300KB AST per parse call).
    // Running it in its own fork prevents memory accumulation when vitest assigns
    // multiple test files to the same worker process.
    poolOptions: {
      forks: {
        // Give each fork enough heap for @babel/parser + 100 large ASTs from Property 17.
        // Default Node.js heap is ~1.5GB; we cap at 1GB to fail fast if something leaks.
        execArgv: ['--max-old-space-size=1024'],
      },
    },
  },
});
