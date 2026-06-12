# Claude Workflow Builder

## Role

You are an automation builder for complete beginners. Users will describe a process they want
automated — often vaguely. Your job is to research, clarify, plan, build, and deploy working
TypeScript automations in Trigger.dev. The user needs zero prior knowledge; guide them through
every step.

## Workflow — Always follow this exact order

1. **Understand** — Listen to the idea. Do not write any code yet.
2. **Research** — Identify the best APIs/services. Check docs, pricing, rate limits, free tiers,
   and authentication requirements.
3. **Clarify** — Ask the user targeted questions (see below). Do not assume anything.
4. **Plan** — Write out what you will build in plain English. Get explicit approval before coding.
5. **Build** — Create TypeScript task files following the conventions below.
6. **Environment Setup** — Add all required env vars to `.env` (local) AND the Trigger.dev
   dashboard (production). Walk the user through both.
7. **Test Locally** — Start the dev server and trigger a test run. Confirm it works.
8. **Deploy** — Use the Trigger.dev MCP deploy tool to push to production.
9. **Verify** — Check run logs and confirm the automation is working end-to-end.

## Questions to Ask Before Writing Any Code

- **Source**: What data or service does this pull from? Does the user have an account/API key?
- **Output**: Where should results go? (ClickUp, email, Slack, a spreadsheet, a database?)
- **Frequency**: Run on a schedule (every hour, daily), respond to an event, or trigger manually?
- **Accounts**: What services does the user already have access to? What needs to be signed up for?
- **Success**: What does "working" look like? What exact output should they see?
- **Edge cases**: What if the source has no new data? What if an API call fails?

## Tech Stack

- **Language**: TypeScript only — no Python scripts, no shell scripts, no exceptions
- **Runtime**: All code runs as Trigger.dev tasks — never plain Node scripts run directly
- **HTTP requests**: Use native `fetch` — no need for axios or node-fetch

## Project Structure

```
src/trigger/{automation-name}/
  {task-name}.ts    ← simple automations can live in a single file
  {check-task}.ts   ← or split when there is a detection phase...
  {process-task}.ts ← ...and a separate heavy-processing phase
```

- Each automation gets its own folder under `src/trigger/`
- A single task file is fine for simple automations
- Split into multiple files when one task detects/polls for new items and another does the heavy work (API calls, LLM, posting output) — see `/trigger-ref` for the orchestrator+processor pattern

## Environment Variables — Security Rules

- **Every secret lives in `.env`** — API keys, tokens, workspace IDs, channel IDs. No exceptions.
- **Never log secret values** — `console.log("Key:", apiKey)` is a security violation
- **Never hardcode credentials** — not even temporarily, not even in comments
- **Always validate at the top of every task**:
  ```ts
  const apiKey = process.env.MY_API_KEY;
  if (!apiKey) throw new Error("MY_API_KEY is not set");
  ```
- **IDs and tokens from third-party services** (workspace IDs, channel IDs, etc.) — always read from env vars, never hardcode or fetch dynamically when a static value will do
- **Before deploying**: add ALL env vars to Trigger.dev dashboard → Project → Environment
  Variables. Add to both staging and prod environments. This is the #1 cause of production failures.
- **Verify `.gitignore` includes `.env`** before any commit. Never commit secrets.
- **When adding a new env var**: add it to `.env` with a descriptive comment explaining where to
  get it, then remind the user to also add it to the Trigger.dev dashboard

## Trigger.dev Critical Rules

- Use `@trigger.dev/sdk` — NEVER `client.defineJob` (v2 pattern, breaks everything)
- Scheduled tasks use `schedules.task` with a `cron` string — always ask the user what frequency
- `triggerAndWait()` returns a `Result` object — always check `result.ok` before `result.output`
- NEVER wrap `triggerAndWait`, `batchTriggerAndWait`, or `wait.*` calls in `Promise.all`
- Use `idempotencyKey` when the same item could be triggered more than once (prevents duplicates)
- Waits longer than 5 seconds are auto-checkpointed and do not count against compute usage
- TypeScript imports between task files need `.js` extension: `import { myTask } from "./my-task.js"`

## Scheduling

Always ask the user what frequency they want before choosing a cron. Common cron patterns:

| Schedule | Cron |
|---|---|
| Every 30 minutes | `"*/30 * * * *"` |
| Every hour | `"0 * * * *"` |
| Every 8 hours | `"0 */8 * * *"` |
| 9am daily | `"0 9 * * *"` |
| Every Monday 8am | `"0 8 * * 1"` |

When polling a feed on a schedule, set the lookback window slightly larger than the cron interval
(e.g., 25 hours for a daily cron) to avoid missing items at the boundary between runs.

## MCP Tools — Use These Instead of CLI When Possible

You have live Trigger.dev MCP tools. Prefer them over running CLI commands in the terminal:

| What you need to do | MCP Tool |
|---|---|
| Deploy to production | `mcp__trigger__deploy` |
| Fire a test run | `mcp__trigger__trigger_task` |
| Wait for a run to finish | `mcp__trigger__wait_for_run_to_complete` |
| Read run logs and errors | `mcp__trigger__get_run_details` |
| List recent runs | `mcp__trigger__list_runs` |
| See all registered tasks | `mcp__trigger__get_current_worker` |

## Testing Locally

1. Start the dev server: `npx trigger.dev@latest dev`
2. Use `mcp__trigger__trigger_task` to fire a test run with a sample payload
3. Watch logs in the terminal — errors appear here in real time
4. Use `mcp__trigger__get_run_details` to inspect the full run trace if something fails

## Deploying to Production

**NEVER push to production or deploy without explicit user approval.** After testing locally,
always ask the user to confirm the automation is working before committing, pushing, or deploying.
Wait for the user to say "push it", "deploy", "ship it", or similar before touching production.

**Checklist — complete this before every deploy:**

- [ ] All env vars added to Trigger.dev dashboard (not just `.env`)
  - Go to: cloud.trigger.dev → your project → Environment Variables
  - Add every key to both staging and prod
- [ ] Tested locally and at least one run succeeded
- [ ] **User has explicitly confirmed** the automation works and approved the deploy
- [ ] `.env` is in `.gitignore`

**Deploy**: push to `master` — GitHub Actions auto-deploys via `.github/workflows/deploy.yml`

**After deploying:**
- Use `mcp__trigger__list_runs` to confirm the first run succeeded
- For scheduled tasks: check the Schedules tab in the dashboard to confirm the cron is registered
- Do a manual test trigger from the dashboard or via `mcp__trigger__trigger_task`

## When a Run Fails

1. Use `mcp__trigger__get_run_details` to read the full error message and trace
2. Most common causes:
   - **Missing env var in dashboard** — key is in `.env` locally but was never added to Trigger.dev
   - **Import path** — TypeScript task imports need `.js` extension (e.g., `"./process-video.js"`)
   - **API auth failure** — wrong key format, expired key, or wrong header name for that API
3. Fix the issue, test locally again, then redeploy

## Adding npm Packages

```bash
npm install {package-name}
npm install -D @types/{package-name}   # only if the package doesn't bundle its own types
```

Trigger.dev bundles `node_modules` automatically on every deploy — no extra config needed.

## Full Trigger.dev API Reference

Use `/trigger-ref` for complete code examples: task patterns, schedules, waits, triggerAndWait,
batch triggers, debounce, and schema tasks with Zod validation.


<!-- TRIGGER.DEV basic START -->
# Trigger.dev Basic Tasks (v4)

**MUST use `@trigger.dev/sdk`, NEVER `client.defineJob`**

## Basic Task

```ts
import { task } from "@trigger.dev/sdk";

export const processData = task({
  id: "process-data",
  retry: {
    maxAttempts: 10,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    randomize: false,
  },
  run: async (payload: { userId: string; data: any[] }) => {
    // Task logic - runs for long time, no timeouts
    console.log(`Processing ${payload.data.length} items for user ${payload.userId}`);
    return { processed: payload.data.length };
  },
});
```

## Schema Task (with validation)

```ts
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const validatedTask = schemaTask({
  id: "validated-task",
  schema: z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email(),
  }),
  run: async (payload) => {
    // Payload is automatically validated and typed
    return { message: `Hello ${payload.name}, age ${payload.age}` };
  },
});
```

## Triggering Tasks

### From Backend Code

```ts
import { tasks } from "@trigger.dev/sdk";
import type { processData } from "./trigger/tasks";

// Single trigger
const handle = await tasks.trigger<typeof processData>("process-data", {
  userId: "123",
  data: [{ id: 1 }, { id: 2 }],
});

// Batch trigger (up to 1,000 items, 3MB per payload)
const batchHandle = await tasks.batchTrigger<typeof processData>("process-data", [
  { payload: { userId: "123", data: [{ id: 1 }] } },
  { payload: { userId: "456", data: [{ id: 2 }] } },
]);
```

### Debounced Triggering

Consolidate multiple triggers into a single execution:

```ts
// Multiple rapid triggers with same key = single execution
await myTask.trigger(
  { userId: "123" },
  {
    debounce: {
      key: "user-123-update",  // Unique key for debounce group
      delay: "5s",              // Wait before executing
    },
  }
);

// Trailing mode: use payload from LAST trigger
await myTask.trigger(
  { data: "latest-value" },
  {
    debounce: {
      key: "trailing-example",
      delay: "10s",
      mode: "trailing",  // Default is "leading" (first payload)
    },
  }
);
```

**Debounce modes:**
- `leading` (default): Uses payload from first trigger, subsequent triggers only reschedule
- `trailing`: Uses payload from most recent trigger

### From Inside Tasks (with Result handling)

```ts
export const parentTask = task({
  id: "parent-task",
  run: async (payload) => {
    // Trigger and continue
    const handle = await childTask.trigger({ data: "value" });

    // Trigger and wait - returns Result object, NOT task output
    const result = await childTask.triggerAndWait({ data: "value" });
    if (result.ok) {
      console.log("Task output:", result.output); // Actual task return value
    } else {
      console.error("Task failed:", result.error);
    }

    // Quick unwrap (throws on error)
    const output = await childTask.triggerAndWait({ data: "value" }).unwrap();

    // Batch trigger and wait
    const results = await childTask.batchTriggerAndWait([
      { payload: { data: "item1" } },
      { payload: { data: "item2" } },
    ]);

    for (const run of results) {
      if (run.ok) {
        console.log("Success:", run.output);
      } else {
        console.log("Failed:", run.error);
      }
    }
  },
});

export const childTask = task({
  id: "child-task",
  run: async (payload: { data: string }) => {
    return { processed: payload.data };
  },
});
```

> Never wrap triggerAndWait or batchTriggerAndWait calls in a Promise.all or Promise.allSettled as this is not supported in Trigger.dev tasks.

## Waits

```ts
import { task, wait } from "@trigger.dev/sdk";

export const taskWithWaits = task({
  id: "task-with-waits",
  run: async (payload) => {
    console.log("Starting task");

    // Wait for specific duration
    await wait.for({ seconds: 30 });
    await wait.for({ minutes: 5 });
    await wait.for({ hours: 1 });
    await wait.for({ days: 1 });

    // Wait until specific date
    await wait.until({ date: new Date("2024-12-25") });

    // Wait for token (from external system)
    await wait.forToken({
      token: "user-approval-token",
      timeoutInSeconds: 3600, // 1 hour timeout
    });

    console.log("All waits completed");
    return { status: "completed" };
  },
});
```

> Never wrap wait calls in a Promise.all or Promise.allSettled as this is not supported in Trigger.dev tasks.

## Key Points

- **Result vs Output**: `triggerAndWait()` returns a `Result` object with `ok`, `output`, `error` properties - NOT the direct task output
- **Type safety**: Use `import type` for task references when triggering from backend
- **Waits > 5 seconds**: Automatically checkpointed, don't count toward compute usage
- **Debounce + idempotency**: Idempotency keys take precedence over debounce settings

## NEVER Use (v2 deprecated)

```ts
// BREAKS APPLICATION
client.defineJob({
  id: "job-id",
  run: async (payload, io) => {
    /* ... */
  },
});
```

Use SDK (`@trigger.dev/sdk`), check `result.ok` before accessing `result.output`

<!-- TRIGGER.DEV basic END -->

<!-- TRIGGER.DEV advanced-tasks START -->
# Trigger.dev Advanced Tasks (v4)

**Advanced patterns and features for writing tasks**

## Tags & Organization

```ts
import { task, tags } from "@trigger.dev/sdk";

export const processUser = task({
  id: "process-user",
  run: async (payload: { userId: string; orgId: string }, { ctx }) => {
    // Add tags during execution
    await tags.add(`user_${payload.userId}`);
    await tags.add(`org_${payload.orgId}`);

    return { processed: true };
  },
});

// Trigger with tags
await processUser.trigger(
  { userId: "123", orgId: "abc" },
  { tags: ["priority", "user_123", "org_abc"] } // Max 10 tags per run
);

// Subscribe to tagged runs
for await (const run of runs.subscribeToRunsWithTag("user_123")) {
  console.log(`User task ${run.id}: ${run.status}`);
}
```

**Tag Best Practices:**

- Use prefixes: `user_123`, `org_abc`, `video:456`
- Max 10 tags per run, 1-64 characters each
- Tags don't propagate to child tasks automatically

## Batch Triggering v2

Enhanced batch triggering with larger payloads and streaming ingestion.

### Limits

- **Maximum batch size**: 1,000 items (increased from 500)
- **Payload per item**: 3MB each (increased from 1MB combined)
- Payloads > 512KB automatically offload to object storage

### Rate Limiting (per environment)

| Tier | Bucket Size | Refill Rate |
|------|-------------|-------------|
| Free | 1,200 runs | 100 runs/10 sec |
| Hobby | 5,000 runs | 500 runs/5 sec |
| Pro | 5,000 runs | 500 runs/5 sec |

### Concurrent Batch Processing

| Tier | Concurrent Batches |
|------|-------------------|
| Free | 1 |
| Hobby | 10 |
| Pro | 10 |

### Usage

```ts
import { myTask } from "./trigger/myTask";

// Basic batch trigger (up to 1,000 items)
const runs = await myTask.batchTrigger([
  { payload: { userId: "user-1" } },
  { payload: { userId: "user-2" } },
  { payload: { userId: "user-3" } },
]);

// Batch trigger with wait
const results = await myTask.batchTriggerAndWait([
  { payload: { userId: "user-1" } },
  { payload: { userId: "user-2" } },
]);

for (const result of results) {
  if (result.ok) {
    console.log("Result:", result.output);
  }
}

// With per-item options
const batchHandle = await myTask.batchTrigger([
  {
    payload: { userId: "123" },
    options: {
      idempotencyKey: "user-123-batch",
      tags: ["priority"],
    },
  },
  {
    payload: { userId: "456" },
    options: {
      idempotencyKey: "user-456-batch",
    },
  },
]);
```

## Debouncing

Consolidate multiple triggers into a single execution by debouncing task runs with a unique key and delay window.

### Use Cases

- **User activity updates**: Batch rapid user actions into a single run
- **Webhook deduplication**: Handle webhook bursts without redundant processing
- **Search indexing**: Combine document updates instead of processing individually
- **Notification batching**: Group notifications to prevent user spam

### Basic Usage

```ts
await myTask.trigger(
  { userId: "123" },
  {
    debounce: {
      key: "user-123-update",  // Unique identifier for debounce group
      delay: "5s",              // Wait duration ("5s", "1m", or milliseconds)
    },
  }
);
```

### Execution Modes

**Leading Mode** (default): Uses payload/options from the first trigger; subsequent triggers only reschedule execution time.

```ts
// First trigger sets the payload
await myTask.trigger({ action: "first" }, {
  debounce: { key: "my-key", delay: "10s" }
});

// Second trigger only reschedules - payload remains "first"
await myTask.trigger({ action: "second" }, {
  debounce: { key: "my-key", delay: "10s" }
});
// Task executes with { action: "first" }
```

**Trailing Mode**: Uses payload/options from the most recent trigger.

```ts
await myTask.trigger(
  { data: "latest-value" },
  {
    debounce: {
      key: "trailing-example",
      delay: "10s",
      mode: "trailing",
    },
  }
);
```

In trailing mode, these options update with each trigger:
- `payload` — task input data
- `metadata` — run metadata
- `tags` — run tags (replaces existing)
- `maxAttempts` — retry attempts
- `maxDuration` — maximum compute time
- `machine` — machine preset

### Important Notes

- Idempotency keys take precedence over debounce settings
- Compatible with `triggerAndWait()` — parent runs block correctly on debounced execution
- Debounce key is scoped to the task

## Concurrency & Queues

```ts
import { task, queue } from "@trigger.dev/sdk";

// Shared queue for related tasks
const emailQueue = queue({
  name: "email-processing",
  concurrencyLimit: 5, // Max 5 emails processing simultaneously
});

// Task-level concurrency
export const oneAtATime = task({
  id: "sequential-task",
  queue: { concurrencyLimit: 1 }, // Process one at a time
  run: async (payload) => {
    // Critical section - only one instance runs
  },
});

// Per-user concurrency
export const processUserData = task({
  id: "process-user-data",
  run: async (payload: { userId: string }) => {
    // Override queue with user-specific concurrency
    await childTask.trigger(payload, {
      queue: {
        name: `user-${payload.userId}`,
        concurrencyLimit: 2,
      },
    });
  },
});

export const emailTask = task({
  id: "send-email",
  queue: emailQueue, // Use shared queue
  run: async (payload: { to: string }) => {
    // Send email logic
  },
});
```

## Error Handling & Retries

```ts
import { task, retry, AbortTaskRunError } from "@trigger.dev/sdk";

export const resilientTask = task({
  id: "resilient-task",
  retry: {
    maxAttempts: 10,
    factor: 1.8, // Exponential backoff multiplier
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    randomize: false,
  },
  catchError: async ({ error, ctx }) => {
    // Custom error handling
    if (error.code === "FATAL_ERROR") {
      throw new AbortTaskRunError("Cannot retry this error");
    }

    // Log error details
    console.error(`Task ${ctx.task.id} failed:`, error);

    // Allow retry by returning nothing
    return { retryAt: new Date(Date.now() + 60000) }; // Retry in 1 minute
  },
  run: async (payload) => {
    // Retry specific operations
    const result = await retry.onThrow(
      async () => {
        return await unstableApiCall(payload);
      },
      { maxAttempts: 3 }
    );

    // Conditional HTTP retries
    const response = await retry.fetch("https://api.example.com", {
      retry: {
        maxAttempts: 5,
        condition: (response, error) => {
          return response?.status === 429 || response?.status >= 500;
        },
      },
    });

    return result;
  },
});
```

## Machines & Performance

```ts
export const heavyTask = task({
  id: "heavy-computation",
  machine: { preset: "large-2x" }, // 8 vCPU, 16 GB RAM
  maxDuration: 1800, // 30 minutes timeout
  run: async (payload, { ctx }) => {
    // Resource-intensive computation
    if (ctx.machine.preset === "large-2x") {
      // Use all available cores
      return await parallelProcessing(payload);
    }

    return await standardProcessing(payload);
  },
});

// Override machine when triggering
await heavyTask.trigger(payload, {
  machine: { preset: "medium-1x" }, // Override for this run
});
```

**Machine Presets:**

- `micro`: 0.25 vCPU, 0.25 GB RAM
- `small-1x`: 0.5 vCPU, 0.5 GB RAM (default)
- `small-2x`: 1 vCPU, 1 GB RAM
- `medium-1x`: 1 vCPU, 2 GB RAM
- `medium-2x`: 2 vCPU, 4 GB RAM
- `large-1x`: 4 vCPU, 8 GB RAM
- `large-2x`: 8 vCPU, 16 GB RAM

## Idempotency

```ts
import { task, idempotencyKeys } from "@trigger.dev/sdk";

export const paymentTask = task({
  id: "process-payment",
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: { orderId: string; amount: number }) => {
    // Automatically scoped to this task run, so if the task is retried, the idempotency key will be the same
    const idempotencyKey = await idempotencyKeys.create(`payment-${payload.orderId}`);

    // Ensure payment is processed only once
    await chargeCustomer.trigger(payload, {
      idempotencyKey,
      idempotencyKeyTTL: "24h", // Key expires in 24 hours
    });
  },
});

// Payload-based idempotency
import { createHash } from "node:crypto";

function createPayloadHash(payload: any): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(payload));
  return hash.digest("hex");
}

export const deduplicatedTask = task({
  id: "deduplicated-task",
  run: async (payload) => {
    const payloadHash = createPayloadHash(payload);
    const idempotencyKey = await idempotencyKeys.create(payloadHash);

    await processData.trigger(payload, { idempotencyKey });
  },
});
```

## Metadata & Progress Tracking

```ts
import { task, metadata } from "@trigger.dev/sdk";

export const batchProcessor = task({
  id: "batch-processor",
  run: async (payload: { items: any[] }, { ctx }) => {
    const totalItems = payload.items.length;

    // Initialize progress metadata
    metadata
      .set("progress", 0)
      .set("totalItems", totalItems)
      .set("processedItems", 0)
      .set("status", "starting");

    const results = [];

    for (let i = 0; i < payload.items.length; i++) {
      const item = payload.items[i];

      // Process item
      const result = await processItem(item);
      results.push(result);

      // Update progress
      const progress = ((i + 1) / totalItems) * 100;
      metadata
        .set("progress", progress)
        .increment("processedItems", 1)
        .append("logs", `Processed item ${i + 1}/${totalItems}`)
        .set("currentItem", item.id);
    }

    // Final status
    metadata.set("status", "completed");

    return { results, totalProcessed: results.length };
  },
});

// Update parent metadata from child task
export const childTask = task({
  id: "child-task",
  run: async (payload, { ctx }) => {
    // Update parent task metadata
    metadata.parent.set("childStatus", "processing");
    metadata.root.increment("childrenCompleted", 1);

    return { processed: true };
  },
});
```

## Logging & Tracing

```ts
import { task, logger } from "@trigger.dev/sdk";

export const tracedTask = task({
  id: "traced-task",
  run: async (payload, { ctx }) => {
    logger.info("Task started", { userId: payload.userId });

    // Custom trace with attributes
    const user = await logger.trace(
      "fetch-user",
      async (span) => {
        span.setAttribute("user.id", payload.userId);
        span.setAttribute("operation", "database-fetch");

        const userData = await database.findUser(payload.userId);
        span.setAttribute("user.found", !!userData);

        return userData;
      },
      { userId: payload.userId }
    );

    logger.debug("User fetched", { user: user.id });

    try {
      const result = await processUser(user);
      logger.info("Processing completed", { result });
      return result;
    } catch (error) {
      logger.error("Processing failed", {
        error: error.message,
        userId: payload.userId,
      });
      throw error;
    }
  },
});
```

## Hidden Tasks

```ts
// Hidden task - not exported, only used internally
const internalProcessor = task({
  id: "internal-processor",
  run: async (payload: { data: string }) => {
    return { processed: payload.data.toUpperCase() };
  },
});

// Public task that uses hidden task
export const publicWorkflow = task({
  id: "public-workflow",
  run: async (payload: { input: string }) => {
    // Use hidden task internally
    const result = await internalProcessor.triggerAndWait({
      data: payload.input,
    });

    if (result.ok) {
      return { output: result.output.processed };
    }

    throw new Error("Internal processing failed");
  },
});
```

## Best Practices

- **Concurrency**: Use queues to prevent overwhelming external services
- **Retries**: Configure exponential backoff for transient failures
- **Idempotency**: Always use for payment/critical operations
- **Metadata**: Track progress for long-running tasks
- **Machines**: Match machine size to computational requirements
- **Tags**: Use consistent naming patterns for filtering
- **Debouncing**: Use for user activity, webhooks, and notification batching
- **Batch triggering**: Use for bulk operations up to 1,000 items
- **Error Handling**: Distinguish between retryable and fatal errors

Design tasks to be stateless, idempotent, and resilient to failures. Use metadata for state tracking and queues for resource management.

<!-- TRIGGER.DEV advanced-tasks END -->

<!-- TRIGGER.DEV config START -->
# Trigger.dev Configuration (v4)

**Complete guide to configuring `trigger.config.ts` with build extensions**

## Basic Configuration

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "<project-ref>", // Required: Your project reference
  dirs: ["./trigger"], // Task directories
  runtime: "node", // "node", "node-22", or "bun"
  logLevel: "info", // "debug", "info", "warn", "error"

  // Default retry settings
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },

  // Build configuration
  build: {
    autoDetectExternal: true,
    keepNames: true,
    minify: false,
    extensions: [], // Build extensions go here
  },

  // Global lifecycle hooks
  onStartAttempt: async ({ payload, ctx }) => {
    console.log("Global task start");
  },
  onSuccess: async ({ payload, output, ctx }) => {
    console.log("Global task success");
  },
  onFailure: async ({ payload, error, ctx }) => {
    console.log("Global task failure");
  },
});
```

## Build Extensions

### Database & ORM

#### Prisma

```ts
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

extensions: [
  prismaExtension({
    schema: "prisma/schema.prisma",
    version: "5.19.0", // Optional: specify version
    migrate: true, // Run migrations during build
    directUrlEnvVarName: "DIRECT_DATABASE_URL",
    typedSql: true, // Enable TypedSQL support
  }),
];
```

#### TypeScript Decorators (for TypeORM)

```ts
import { emitDecoratorMetadata } from "@trigger.dev/build/extensions/typescript";

extensions: [
  emitDecoratorMetadata(), // Enables decorator metadata
];
```

### Scripting Languages

#### Python

```ts
import { pythonExtension } from "@trigger.dev/build/extensions/python";

extensions: [
  pythonExtension({
    scripts: ["./python/**/*.py"], // Copy Python files
    requirementsFile: "./requirements.txt", // Install packages
    devPythonBinaryPath: ".venv/bin/python", // Dev mode binary
  }),
];

// Usage in tasks
const result = await python.runInline(`print("Hello, world!")`);
const output = await python.runScript("./python/script.py", ["arg1"]);
```

### Browser Automation

#### Playwright

```ts
import { playwright } from "@trigger.dev/build/extensions/playwright";

extensions: [
  playwright({
    browsers: ["chromium", "firefox", "webkit"], // Default: ["chromium"]
    headless: true, // Default: true
  }),
];
```

#### Puppeteer

```ts
import { puppeteer } from "@trigger.dev/build/extensions/puppeteer";

extensions: [puppeteer()];

// Environment variable needed:
// PUPPETEER_EXECUTABLE_PATH: "/usr/bin/google-chrome-stable"
```

#### Lightpanda

```ts
import { lightpanda } from "@trigger.dev/build/extensions/lightpanda";

extensions: [
  lightpanda({
    version: "latest", // or "nightly"
    disableTelemetry: false,
  }),
];
```

### Media Processing

#### FFmpeg

```ts
import { ffmpeg } from "@trigger.dev/build/extensions/core";

extensions: [
  ffmpeg({ version: "7" }), // Static build, or omit for Debian version
];

// Automatically sets FFMPEG_PATH and FFPROBE_PATH
// Add fluent-ffmpeg to external packages if using
```

#### Audio Waveform

```ts
import { audioWaveform } from "@trigger.dev/build/extensions/audioWaveform";

extensions: [
  audioWaveform(), // Installs Audio Waveform 1.1.0
];
```

### System & Package Management

#### System Packages (apt-get)

```ts
import { aptGet } from "@trigger.dev/build/extensions/core";

extensions: [
  aptGet({
    packages: ["ffmpeg", "imagemagick", "curl=7.68.0-1"], // Can specify versions
  }),
];
```

#### Additional NPM Packages

Only use this for installing CLI tools, NOT packages you import in your code.

```ts
import { additionalPackages } from "@trigger.dev/build/extensions/core";

extensions: [
  additionalPackages({
    packages: ["wrangler"], // CLI tools and specific versions
  }),
];
```

#### Additional Files

```ts
import { additionalFiles } from "@trigger.dev/build/extensions/core";

extensions: [
  additionalFiles({
    files: ["wrangler.toml", "./assets/**", "./fonts/**"], // Glob patterns supported
  }),
];
```

### Environment & Build Tools

#### Environment Variable Sync

```ts
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

extensions: [
  syncEnvVars(async (ctx) => {
    // ctx contains: environment, projectRef, env
    return [
      { name: "SECRET_KEY", value: await getSecret(ctx.environment) },
      { name: "API_URL", value: ctx.environment === "prod" ? "api.prod.com" : "api.dev.com" },
    ];
  }),
];
```

#### ESBuild Plugins

```ts
import { esbuildPlugin } from "@trigger.dev/build/extensions";
import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";

extensions: [
  esbuildPlugin(
    sentryEsbuildPlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
    { placement: "last", target: "deploy" } // Optional config
  ),
];
```

## Custom Build Extensions

```ts
import { defineConfig } from "@trigger.dev/sdk";

const customExtension = {
  name: "my-custom-extension",

  externalsForTarget: (target) => {
    return ["some-native-module"]; // Add external dependencies
  },

  onBuildStart: async (context) => {
    console.log(`Build starting for ${context.target}`);
    // Register esbuild plugins, modify build context
  },

  onBuildComplete: async (context, manifest) => {
    console.log("Build complete, adding layers");
    // Add build layers, modify deployment
    context.addLayer({
      id: "my-layer",
      files: [{ source: "./custom-file", destination: "/app/custom" }],
      commands: ["chmod +x /app/custom"],
    });
  },
};

export default defineConfig({
  project: "my-project",
  build: {
    extensions: [customExtension],
  },
});
```

## Advanced Configuration

### Telemetry

```ts
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { OpenAIInstrumentation } from "@langfuse/openai";

export default defineConfig({
  // ... other config
  telemetry: {
    instrumentations: [new PrismaInstrumentation(), new OpenAIInstrumentation()],
    exporters: [customExporter], // Optional custom exporters
  },
});
```

### Machine & Performance

```ts
export default defineConfig({
  // ... other config
  defaultMachine: "large-1x", // Default machine for all tasks
  maxDuration: 300, // Default max duration (seconds)
  enableConsoleLogging: true, // Console logging in development
});
```

## Common Extension Combinations

### Full-Stack Web App

```ts
extensions: [
  prismaExtension({ schema: "prisma/schema.prisma", migrate: true }),
  additionalFiles({ files: ["./public/**", "./assets/**"] }),
  syncEnvVars(async (ctx) => [...envVars]),
];
```

### AI/ML Processing

```ts
extensions: [
  pythonExtension({
    scripts: ["./ai/**/*.py"],
    requirementsFile: "./requirements.txt",
  }),
  ffmpeg({ version: "7" }),
  additionalPackages({ packages: ["wrangler"] }),
];
```

### Web Scraping

```ts
extensions: [
  playwright({ browsers: ["chromium"] }),
  puppeteer(),
  additionalFiles({ files: ["./selectors.json", "./proxies.txt"] }),
];
```

## Best Practices

- **Use specific versions**: Pin extension versions for reproducible builds
- **External packages**: Add modules with native addons to the `build.external` array
- **Environment sync**: Use `syncEnvVars` for dynamic secrets
- **File paths**: Use glob patterns for flexible file inclusion
- **Debug builds**: Use `--log-level debug --dry-run` for troubleshooting

Extensions only affect deployment, not local development. Use `external` array for packages that shouldn't be bundled.

<!-- TRIGGER.DEV config END -->

<!-- TRIGGER.DEV scheduled-tasks START -->
# Scheduled tasks (cron)

Recurring tasks using cron. For one-off future runs, use the **delay** option.

## Define a scheduled task

```ts
import { schedules } from "@trigger.dev/sdk";

export const task = schedules.task({
  id: "first-scheduled-task",
  run: async (payload) => {
    payload.timestamp; // Date (scheduled time, UTC)
    payload.lastTimestamp; // Date | undefined
    payload.timezone; // IANA, e.g. "America/New_York" (default "UTC")
    payload.scheduleId; // string
    payload.externalId; // string | undefined
    payload.upcoming; // Date[]

    payload.timestamp.toLocaleString("en-US", { timeZone: payload.timezone });
  },
});
```

> Scheduled tasks need at least one schedule attached to run.

## Attach schedules

**Declarative (sync on dev/deploy):**

```ts
schedules.task({
  id: "every-2h",
  cron: "0 */2 * * *", // UTC
  run: async () => {},
});

schedules.task({
  id: "tokyo-5am",
  cron: { pattern: "0 5 * * *", timezone: "Asia/Tokyo", environments: ["PRODUCTION", "STAGING"] },
  run: async () => {},
});
```

**Imperative (SDK or dashboard):**

```ts
await schedules.create({
  task: task.id,
  cron: "0 0 * * *",
  timezone: "America/New_York", // DST-aware
  externalId: "user_123",
  deduplicationKey: "user_123-daily", // updates if reused
});
```

### Dynamic / multi-tenant example

```ts
// /trigger/reminder.ts
export const reminderTask = schedules.task({
  id: "todo-reminder",
  run: async (p) => {
    if (!p.externalId) throw new Error("externalId is required");
    const user = await db.getUser(p.externalId);
    await sendReminderEmail(user);
  },
});
```

```ts
// app/reminders/route.ts
export async function POST(req: Request) {
  const data = await req.json();
  return Response.json(
    await schedules.create({
      task: reminderTask.id,
      cron: "0 8 * * *",
      timezone: data.timezone,
      externalId: data.userId,
      deduplicationKey: `${data.userId}-reminder`,
    })
  );
}
```

## Cron syntax (no seconds)

```
* * * * *
| | | | └ day of week (0–7 or 1L–7L; 0/7=Sun; L=last)
| | | └── month (1–12)
| | └──── day of month (1–31 or L)
| └────── hour (0–23)
└──────── minute (0–59)
```

## When schedules won't trigger

- **Dev:** only when the dev CLI is running.
- **Staging/Production:** only for tasks in the **latest deployment**.

## SDK management (quick refs)

```ts
await schedules.retrieve(id);
await schedules.list();
await schedules.update(id, { cron: "0 0 1 * *", externalId: "ext", deduplicationKey: "key" });
await schedules.deactivate(id);
await schedules.activate(id);
await schedules.del(id);
await schedules.timezones(); // list of IANA timezones
```

## Dashboard

Create/attach schedules visually (Task, Cron pattern, Timezone, Optional: External ID, Dedup key, Environments). Test scheduled tasks from the **Test** page.

<!-- TRIGGER.DEV scheduled-tasks END -->

<!-- TRIGGER.DEV realtime START -->
# Trigger.dev Realtime (v4)

**Real-time monitoring and updates for runs**

## Core Concepts

Realtime allows you to:

- Subscribe to run status changes, metadata updates, and streams
- Build real-time dashboards and UI updates
- Monitor task progress from frontend and backend

## Authentication

### Public Access Tokens

```ts
import { auth } from "@trigger.dev/sdk";

// Read-only token for specific runs
const publicToken = await auth.createPublicToken({
  scopes: {
    read: {
      runs: ["run_123", "run_456"],
      tasks: ["my-task-1", "my-task-2"],
    },
  },
  expirationTime: "1h", // Default: 15 minutes
});
```

### Trigger Tokens (Frontend only)

```ts
// Single-use token for triggering tasks
const triggerToken = await auth.createTriggerPublicToken("my-task", {
  expirationTime: "30m",
});
```

## Backend Usage

### Subscribe to Runs

```ts
import { runs, tasks } from "@trigger.dev/sdk";

// Trigger and subscribe
const handle = await tasks.trigger("my-task", { data: "value" });

// Subscribe to specific run
for await (const run of runs.subscribeToRun<typeof myTask>(handle.id)) {
  console.log(`Status: ${run.status}, Progress: ${run.metadata?.progress}`);
  if (run.status === "COMPLETED") break;
}

// Subscribe to runs with tag
for await (const run of runs.subscribeToRunsWithTag("user-123")) {
  console.log(`Tagged run ${run.id}: ${run.status}`);
}

// Subscribe to batch
for await (const run of runs.subscribeToBatch(batchId)) {
  console.log(`Batch run ${run.id}: ${run.status}`);
}
```

### Realtime Streams v2 (Recommended)

```ts
import { streams, InferStreamType } from "@trigger.dev/sdk";

// 1. Define streams (shared location)
export const aiStream = streams.define<string>({
  id: "ai-output",
});

export type AIStreamPart = InferStreamType<typeof aiStream>;

// 2. Pipe from task
export const streamingTask = task({
  id: "streaming-task",
  run: async (payload) => {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: payload.prompt }],
      stream: true,
    });

    const { waitUntilComplete } = aiStream.pipe(completion);
    await waitUntilComplete();
  },
});

// 3. Read from backend
const stream = await aiStream.read(runId, {
  timeoutInSeconds: 300,
  startIndex: 0, // Resume from specific chunk
});

for await (const chunk of stream) {
  console.log("Chunk:", chunk); // Fully typed
}
```

Enable v2 by upgrading to 4.1.0 or later.

## React Frontend Usage

### Installation

```bash
npm add @trigger.dev/react-hooks
```

### Triggering Tasks

```tsx
"use client";
import { useTaskTrigger, useRealtimeTaskTrigger } from "@trigger.dev/react-hooks";
import type { myTask } from "../trigger/tasks";

function TriggerComponent({ accessToken }: { accessToken: string }) {
  // Basic trigger
  const { submit, handle, isLoading } = useTaskTrigger<typeof myTask>("my-task", {
    accessToken,
  });

  // Trigger with realtime updates
  const {
    submit: realtimeSubmit,
    run,
    isLoading: isRealtimeLoading,
  } = useRealtimeTaskTrigger<typeof myTask>("my-task", { accessToken });

  return (
    <div>
      <button onClick={() => submit({ data: "value" })} disabled={isLoading}>
        Trigger Task
      </button>

      <button onClick={() => realtimeSubmit({ data: "realtime" })} disabled={isRealtimeLoading}>
        Trigger with Realtime
      </button>

      {run && <div>Status: {run.status}</div>}
    </div>
  );
}
```

### Subscribing to Runs

```tsx
"use client";
import { useRealtimeRun, useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import type { myTask } from "../trigger/tasks";

function SubscribeComponent({ runId, accessToken }: { runId: string; accessToken: string }) {
  // Subscribe to specific run
  const { run, error } = useRealtimeRun<typeof myTask>(runId, {
    accessToken,
    onComplete: (run) => {
      console.log("Task completed:", run.output);
    },
  });

  // Subscribe to tagged runs
  const { runs } = useRealtimeRunsWithTag("user-123", { accessToken });

  if (error) return <div>Error: {error.message}</div>;
  if (!run) return <div>Loading...</div>;

  return (
    <div>
      <div>Status: {run.status}</div>
      <div>Progress: {run.metadata?.progress || 0}%</div>
      {run.output && <div>Result: {JSON.stringify(run.output)}</div>}

      <h3>Tagged Runs:</h3>
      {runs.map((r) => (
        <div key={r.id}>
          {r.id}: {r.status}
        </div>
      ))}
    </div>
  );
}
```

### Realtime Streams with React

```tsx
"use client";
import { useRealtimeStream } from "@trigger.dev/react-hooks";
import { aiStream } from "../trigger/streams";

function StreamComponent({ runId, accessToken }: { runId: string; accessToken: string }) {
  // Pass defined stream directly for type safety
  const { parts, error } = useRealtimeStream(aiStream, runId, {
    accessToken,
    timeoutInSeconds: 300,
    throttleInMs: 50, // Control re-render frequency
  });

  if (error) return <div>Error: {error.message}</div>;
  if (!parts) return <div>Loading...</div>;

  const text = parts.join(""); // parts is typed as AIStreamPart[]

  return <div>Streamed Text: {text}</div>;
}
```

### Wait Tokens

```tsx
"use client";
import { useWaitToken } from "@trigger.dev/react-hooks";

function WaitTokenComponent({ tokenId, accessToken }: { tokenId: string; accessToken: string }) {
  const { complete } = useWaitToken(tokenId, { accessToken });

  return <button onClick={() => complete({ approved: true })}>Approve Task</button>;
}
```

### SWR Hooks (Fetch Once)

```tsx
"use client";
import { useRun } from "@trigger.dev/react-hooks";
import type { myTask } from "../trigger/tasks";

function SWRComponent({ runId, accessToken }: { runId: string; accessToken: string }) {
  const { run, error, isLoading } = useRun<typeof myTask>(runId, {
    accessToken,
    refreshInterval: 0, // Disable polling (recommended)
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <div>Run: {run?.status}</div>;
}
```

## Run Object Properties

Key properties available in run subscriptions:

- `id`: Unique run identifier
- `status`: `QUEUED`, `EXECUTING`, `COMPLETED`, `FAILED`, `CANCELED`, etc.
- `payload`: Task input data (typed)
- `output`: Task result (typed, when completed)
- `metadata`: Real-time updatable data
- `createdAt`, `updatedAt`: Timestamps
- `costInCents`: Execution cost

## Best Practices

- **Use Realtime over SWR**: Recommended for most use cases due to rate limits
- **Scope tokens properly**: Only grant necessary read/trigger permissions
- **Handle errors**: Always check for errors in hooks and subscriptions
- **Type safety**: Use task types for proper payload/output typing
- **Cleanup subscriptions**: Backend subscriptions auto-complete, frontend hooks auto-cleanup

<!-- TRIGGER.DEV realtime END -->