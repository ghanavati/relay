# Deferred items — discovered by executor #7 (budget)

## 2026-05-18 — pre-existing TS error in src/memory/embedding-client.test.ts

- **File:** `src/memory/embedding-client.test.ts`
- **Error:** `TS2307: Cannot find module './embedding-client.js' or its corresponding type declarations.`
- **Owner:** PLAN-4 / executor #4 (semantic embeddings). Test file ships ahead of
  the implementation it covers.
- **Why not fixed here:** explicitly out of scope per executor #7 directives
  ("DO NOT touch src/memory/memory-*" — applies generally to memory subsystem
  in-flight changes).
- **Impact on this executor:** noisy in `npm run build` / `npm test`, but does
  not affect the budget subsystem. Verified by running only the budget tests:
  `node --test dist/runtime/budget/**/*.test.js` (all green).
