# Workspace Integration & End-to-End Tests (`tests`)

This directory contains workspace-level integration, cross-package, and end-to-end simulation tests.

## Running Tests

Tests are executed with Vitest from the workspace root:

```bash
pnpm test
```

## Structure

- `foundation.test.ts`: Verifies workspace package resolution, TypeScript compilation, and boundary module exports.
- Future tests: Simulated transmission pipelines, protocol handshakes, and reassembly validation.
