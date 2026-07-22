# Example: Review a Project and Apply Fixes

A step-by-step walkthrough of using `aether review` to audit a codebase and automatically apply fixes.

---

## Scenario

You've inherited a TypeScript project and want to audit it for bugs, security issues, and code quality problems. You'll run a full review, export findings as JSON for your CI pipeline, and auto-apply the safe fixes.

---

## Step 1: Full Project Review

```bash
aether review ./src
```

Expected output:
```
🔍 Aether Review — ./src

Scanning 47 files across 8 directories...

src/auth/login.ts
  ERROR    line 23  SQL injection risk — user input interpolated directly into query
  WARNING  line 45  Password hashing uses SHA-256 (weak) — use bcrypt or argon2
  WARNING  line 67  Missing rate limiting on login endpoint

src/api/handlers.ts
  ERROR    line 12  Unhandled promise rejection in error path
  WARNING  line 34  Response body not validated against schema
     INFO  line 56  Consider using async handler wrapper

src/utils/parser.ts
  ERROR    line 8   JSON.parse without try/catch — crashes on malformed input
     INFO  line 19  Could use zod or yup for schema validation

src/db/connection.ts
  WARNING  line 15  Database connection not pooled — may exhaust connections under load
     INFO  line 30  Missing connection timeout

────────────────────────────────────────────────────────────
Summary: 3 errors, 5 warnings, 3 info across 4 files
```

---

## Step 2: Filter by Severity

Focus on what matters most — errors only:

```bash
aether review ./src --severity error
```

Expected output:
```
🔍 Aether Review — ./src (severity: error)

src/auth/login.ts
  ERROR  line 23  SQL injection risk — user input interpolated directly into query

src/api/handlers.ts
  ERROR  line 12  Unhandled promise rejection in error path

src/utils/parser.ts
  ERROR  line 8   JSON.parse without try/catch — crashes on malformed input

────────────────────────────────────────────────────────────
3 errors found. Run with --apply to auto-fix.
```

---

## Step 3: Export as JSON (CI/CD)

Machine-readable output for your pipeline:

```bash
aether review ./src --severity error --json
```

```json
{
  "success": true,
  "target": "./src",
  "findings": [
    {
      "file": "src/auth/login.ts",
      "line": 23,
      "severity": "error",
      "message": "SQL injection risk — user input interpolated directly into query",
      "suggestion": "Use parameterized queries or an ORM"
    },
    {
      "file": "src/api/handlers.ts",
      "line": 12,
      "severity": "error",
      "message": "Unhandled promise rejection in error path",
      "suggestion": "Wrap in try/catch or add .catch() handler"
    },
    {
      "file": "src/utils/parser.ts",
      "line": 8,
      "severity": "error",
      "message": "JSON.parse without try/catch — crashes on malformed input",
      "suggestion": "Wrap JSON.parse in try/catch, return default or throw typed error"
    }
  ],
  "summary": {
    "error": 3,
    "warning": 0,
    "info": 0,
    "totalFiles": 47,
    "filesWithIssues": 3
  }
}
```

### CI Integration Example (GitHub Actions)

```yaml
- name: Aether Code Review
  run: |
    aether review ./src --severity error --json > review.json
    ERROR_COUNT=$(jq '.summary.error' review.json)
    if [ "$ERROR_COUNT" -gt 0 ]; then
      echo "::error::Found $ERROR_COUNT errors. See review.json for details."
      exit 1
    fi
```

---

## Step 4: Dry-Run Auto-Fix

Preview what Aether will change before applying:

```bash
aether review ./src --apply --dry-run
```

Expected output:
```
🔍 Aether Review — ./src
[DRY RUN] No files will be modified.

Would fix:
  ✎ src/auth/login.ts:23     Replace string interpolation with parameterized query
  ✎ src/api/handlers.ts:12   Wrap in try/catch block
  ✎ src/utils/parser.ts:8    Add try/catch around JSON.parse

3 fixes identified across 3 files.
```

---

## Step 5: Apply Fixes

When you're ready:

```bash
aether review ./src --severity error --apply
```

Expected output:
```
🔍 Aether Review — ./src

Fixing src/auth/login.ts:23... ✓
  - replaced:  query(`SELECT * FROM users WHERE email = '${email}'`)
  + added:     query('SELECT * FROM users WHERE email = $1', [email])

Fixing src/api/handlers.ts:12... ✓
  + wrapped handler in try/catch with error response

Fixing src/utils/parser.ts:8... ✓
  + added try/catch around JSON.parse

────────────────────────────────────────────────────────────
✓ Applied 3 fixes. Run tests to verify: aether test ./src
```

---

## Step 6: Verify with Tests

```bash
aether test ./src --run --coverage
```

---

## Tips

- **Review incrementally**: Run `aether review` on changed files before committing
- **Use `--json` in pre-commit hooks** to block commits with errors
- **Combine with `--apply`** for automated cleanup of warnings and info-level issues
- **Review specific files**: `aether review ./src/auth/login.ts` for targeted audits
- **Different LLMs for review**: Try `--provider anthropic --model claude-sonnet-4-20250514` for security-focused reviews (Claude excels at finding subtle bugs)

---

## Related

- [Generate a REST API Endpoint](./generate-api.md)
- [Generate a Test Suite](./test-suite.md)
