# Example: Generate a Test Suite, Run It, and Auto-Fix Failures

A step-by-step walkthrough of using `aether test` to generate tests, execute them, and automatically fix any that fail.

---

## Scenario

You've built a TypeScript utility library (`src/utils/math.ts`, `src/utils/string.ts`, `src/utils/array.ts`) but haven't written tests yet. You'll use Aether to generate a full test suite, run it with coverage, and auto-fix any failing tests.

---

## Step 1: Preview the Test Plan

```bash
aether test ./src/utils --dry-run
```

Expected output:
```
🧪 Aether Test
[DRY RUN] No API calls. No files created.

Project scan:
  Detected runner: vitest (found vitest.config.ts)
  Test directory:  src/__tests__/

Would generate:
  ➜ src/__tests__/math.test.ts     — Tests for add, subtract, multiply, divide
  ➜ src/__tests__/string.test.ts   — Tests for capitalize, slugify, truncate
  ➜ src/__tests__/array.test.ts    — Tests for chunk, unique, groupBy

3 test files will be generated.
Estimated: ~45 test cases total.
```

---

## Step 2: Generate and Run Tests

```bash
aether test ./src/utils --provider openai --coverage
```

Expected output:
```
🧪 Aether Test
   Provider: openai
   Model: gpt-4o
   Framework: vitest (auto-detected)

Generating tests...
✔ Generated 3 test files (42 test cases)

Running tests...
vitest run --coverage

 ✓ src/__tests__/math.test.ts (12 tests) ........... 312ms
 ✓ src/__tests__/string.test.ts (14 tests) ......... 289ms
 ✗ src/__tests__/array.test.ts (16 tests) .......... 401ms
   ❌ chunk › handles empty array — expected [] got undefined
   ❌ groupBy › groups by nested property — expected Map, got object

Tests: 40 passed, 2 failed, 42 total
Coverage: 87.3% (target: 80%)
Time: 1.2s

⚠ 2 tests failed. Use --fix to auto-fix.
```

---

## Step 3: Auto-Fix Failing Tests

```bash
aether test ./src/utils --fix
```

Expected output:
```
🧪 Aether Test
   Provider: openai

Running existing tests...
✗ 2 failures detected.

Auto-fix attempt 1/3...
Analyzing failures:
  ❌ chunk › handles empty array — implementation returns [] for empty, test expects undefined
  ❌ groupBy › groups by nested property — implementation returns Map, test expects plain object

Regenerating src/__tests__/array.test.ts...
✔ Updated 2 test cases

Running tests...
 ✓ src/__tests__/array.test.ts (16 tests) .......... 398ms

Tests: 42 passed, 0 failed, 42 total
Coverage: 88.1%

✓ All tests pass! Auto-fix succeeded after 1 attempt.
```

---

## Step 4: Run Only (Skip Generation)

Once tests exist, use `--run` to skip generation:

```bash
aether test ./src/utils --run --coverage
```

Expected output:
```
🧪 Aether Test
   Mode: run only (skip generation)

 ✓ src/__tests__/math.test.ts (12 tests) ........... 305ms
 ✓ src/__tests__/string.test.ts (14 tests) ......... 291ms
 ✓ src/__tests__/array.test.ts (16 tests) .......... 387ms

Tests: 42 passed, 0 failed, 42 total
Coverage: 88.1%
Time: 0.98s
```

---

## Step 5: Run Specific Test Files

```bash
aether test ./src/utils --run --files src/__tests__/math.test.ts
```

---

## Step 6: Watch Mode

```bash
aether test ./src/utils --run --watch
```

Aether delegates to your test runner's watch mode. Files change → tests re-run automatically.

---

## Step 7: Override the Test Framework

If auto-detection picks the wrong runner:

```bash
# Force Jest instead of auto-detected vitest
aether test ./src --framework jest --coverage

# Force bun test
aether test ./src --framework bun --run
```

Valid frameworks: `vitest`, `jest`, `bun`, `mocha`, `node-test`.

---

## The Auto-Fix Loop

When `--fix` is used, Aether runs a smart retry loop:

```
1. Run existing tests → collect failures
2. For each failing test, send the test + error to LLM:
   - Was the test expectation wrong? → Fix the test
   - Was the implementation wrong? → Fix the implementation
3. Re-run tests
4. If still failing, retry (up to 3 attempts)
5. Report final results
```

The fixer (`utils/fixer.ts`) sends each failure to the LLM with:
- The test file content
- The source file being tested
- The exact error message and stack trace
- A prompt asking to reconcile the test and implementation

---

## Tips

- **Always `--dry-run` first** to see what tests will be generated before spending API credits
- **Use `--fix` sparingly** — it can consume significant API tokens (up to 3 calls per failing test)
- **Combine with `--coverage`** to verify your tests actually exercise the code
- **Generate tests file-by-file** for large projects: `aether test ./src/module-a.ts`, then `./src/module-b.ts`
- **Use different providers** for generation vs. fixing — some models are better at understanding test failures
- **`--run --watch`** is great for TDD workflows: write code, save, watch tests pass

---

## Related

- [Generate a REST API Endpoint](./generate-api.md)
- [Review a Project and Apply Fixes](./review-project.md)
