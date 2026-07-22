# Example: Generate a REST API Endpoint

A step-by-step walkthrough of using `aether generate` to create a complete REST API endpoint.

---

## Scenario

You're building a task management application and need a REST API endpoint for creating and listing tasks. You want TypeScript, input validation, and proper error handling — all generated from a natural language prompt.

---

## Step 1: Set Up Your Provider

```bash
# Check which providers are available
aether env

# Set your default provider (skip if already set)
aether config set provider openai
aether config set model gpt-4o
```

---

## Step 2: Dry-Run the Generation

Always preview first. Aether will scan your project and show what it plans to create:

```bash
aether generate "Create a REST API endpoint for task management with:
- POST /tasks to create a task (title, description, priority)
- GET /tasks to list tasks with optional status filter
- Input validation with meaningful error messages
- TypeScript types
- In-memory storage" --dry-run
```

Expected output:
```
⚡ Aether Generate
   Provider: openai
   Model: gpt-4o
   Mode: auto
   Target: /home/user/project
   Prompt: Create a REST API endpoint for task management...

[DRY RUN] No files will be written.

Would create:
  src/types/task.ts         — Task, CreateTaskInput, TaskStatus types
  src/storage/task-store.ts — In-memory TaskStore class
  src/routes/tasks.ts       — POST /tasks, GET /tasks handlers
  src/middleware/validate.ts — Input validation middleware
```

---

## Step 3: Generate to a Target Directory

```bash
aether generate "Create a REST API endpoint for task management with:
- POST /tasks to create a task (title, description, priority)
- GET /tasks to list tasks with optional status filter
- Input validation with meaningful error messages
- TypeScript types
- In-memory storage" --target ./src
```

Expected output:
```
⚡ Aether Generate
   Provider: openai
   Model: gpt-4o
   Mode: auto
   Target: ./src
   Prompt: Create a REST API endpoint for task management...

✔ Generated 4 files
  ➜ src/types/task.ts          (created, 342 B)
  ➜ src/storage/task-store.ts  (created, 1.2 KB)
  ➜ src/routes/tasks.ts        (created, 2.1 KB)
  ➜ src/middleware/validate.ts (created, 856 B)

✓ Done. Run `aether test ./src` to generate tests for these files.
```

---

## Step 4: Review the Generated Code

```bash
aether review ./src/routes/tasks.ts --severity warning
```

Expected output:
```
🔍 Aether Review — src/routes/tasks.ts

  WARNING  src/routes/tasks.ts:24  Missing rate limiting on POST endpoint
  WARNING  src/routes/tasks.ts:42  Consider paginating GET /tasks response
     INFO  src/routes/tasks.ts:15  Good: input validation before business logic

Found 2 warnings, 1 info in 1 file.
```

---

## Step 5: Iterate with Edit Mode

Need to add a DELETE endpoint? Use edit mode to modify existing files:

```bash
aether generate "Add DELETE /tasks/:id endpoint to src/routes/tasks.ts with proper 404 handling" --mode edit
```

Expected output:
```
⚡ Aether Generate
   Provider: openai
   Mode: edit
   Target: ./src

✔ Modified 1 file
  ✎ src/routes/tasks.ts (2 insertions, 0 deletions)

✓ Done.
```

---

## Step 6: Generate Tests

```bash
aether test ./src/routes/tasks.ts --coverage
```

---

## Tips

- **Use `--mode create`** when you want only new files (won't touch existing code)
- **Use `--mode edit`** when you want to modify existing files only
- **Use `--mode auto`** (default) to let Aether decide based on what exists
- **Use `--force`** to skip the overwrite confirmation prompt in scripts/CI
- **Pipe prompts from stdin**: `echo "Add error logging" | aether generate --mode edit`
- **Read prompts from files**: `aether generate --file ./feature-spec.md`

---

## Related

- [Review a Project and Apply Fixes](./review-project.md)
- [Generate a Test Suite](./test-suite.md)
