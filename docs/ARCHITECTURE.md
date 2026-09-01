# Architecture

## Components

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Browser (static page served by the Java service, port 8080)               │
│    [Send Alert]  [Simulate Error]        pipeline timeline (read-only)      │
└───────┬──────────────────────────────────────────────────▲─────────────────┘
        │ POST /api/alert | /api/error                     │ GET /status
        ▼                                                  │
┌────────────────────────────────┐                          │
│  demo-app (Spring Boot, 8080)  │                          │
│   EventController              │                          │
│   InvoiceService  ← the defect │                          │
│   CloudWatchLogsAppender       │                          │
└───────┬────────────────────────┘                          │
        │ PutLogEvents (JSON, async batches)                │
        ▼                                                   │
┌────────────────────────────────┐                          │
│  AWS CloudWatch Logs           │                          │
│  /gsc-poc/demo-app             │                          │
└───────┬────────────────────────┘                          │
        │ FilterLogEvents (poll, 3s)                        │
        ▼                                                   │
┌───────────────────────────────────────────────────────────┴──────────────┐
│  orchestrator (Node.js, 8090)                                            │
│                                                                          │
│   cloudwatch.js ──► classifier.js ──┬── ALERT ──► notifier.js (1 email)   │
│                                     │                                    │
│                                     └── ERROR ──► notifier.js (email #1)  │
│                                                 ──► agent/ (LLM + tools)  │
│                                                 ──► mvn test (validate)   │
│                                                 ──► git.js (branch/PR)    │
│                                                 ──► notifier.js (email #2)│
│                                                                          │
│   status.js  ── incident timelines, served by the read-only status API    │
└──────────────────────────────────────────────────────────────────────────┘
```

## Key decisions

### The frontend cannot start the agent

The two buttons only call the Java service, which only writes logs. The orchestrator
discovers work by reading CloudWatch. Nothing in the request path from the browser
reaches the agent.

This matters because it is the actual claim being demonstrated: a production signal — not
a human pressing a button labelled "fix it" — initiates the engineering workflow. The
frontend's `GET /status` is read-only observability.

### Polling CloudWatch instead of a subscription filter

`FilterLogEvents` on a 3-second timer is the simplest mechanism that genuinely reads from
CloudWatch. The alternative — a subscription filter pushing to Lambda — cannot work here,
because the agent has to run Maven and Git against a repository checkout, which a Lambda
cannot do, and a local machine cannot receive a push from AWS without a tunnel.

**Production shape:** subscription filter → EventBridge or SQS → containerised worker
(ECS/CodeBuild) that owns the checkout. The seam is `createLogPoller`'s `onRecord`
callback: replace the poller with a queue consumer and nothing downstream changes.

### Rule-based classification, not an LLM

Classification runs on every log line, must be deterministic, and must be explainable in
a review. The rules live in `classifier.js`:

| Input | Classification | Why |
|---|---|---|
| `ERROR`/`FATAL` with an exception and an application stack frame | **ERROR** | A located code defect — the agent can act on it |
| `ERROR`/`FATAL` with no application frame | **ALERT** | Infrastructure or dependency failure; an autonomous code change would be guesswork |
| `WARN` | **ALERT** | Operational condition, not a defect |
| anything else | **IGNORE** | Routine logging |

Frames inside `com.gsc.poc.logging` are skipped when locating the defect, so a logging
failure is never mistaken for a business-logic bug.

**Extension:** the classification function is pure and takes a parsed record, so adding
severity scoring, deduplication windows, or an LLM triage tier is a change to one module.

### JSON logs

The appender emits structured JSON rather than formatted text, so the classifier reads
fields instead of parsing prose, and the incident ID from `MDC` survives the trip through
CloudWatch. It also means CloudWatch Logs Insights can query the events directly.

### Codebase understanding: repo instructions plus targeted retrieval

The agent's context comes from four places:

0. **Pre-fetched sources.** The classifier already extracted `InvoiceService.java:34` from
   the stack frame, so the pipeline reads that file and its test file and hands both over
   in the opening message. The agent does not spend round trips rediscovering what the
   pipeline already knows. This is ordinary retrieval-augmented context, and it cut a run
   from 16 tool calls to 7 — which matters most under a per-minute token budget.


1. **`AGENTS.md`** — the repository's own instructions: layout, conventions, how to test,
   what not to touch. The prompt tells the agent to read it first and treat it as binding.
2. **The stack frame** — the classifier extracts `InvoiceService.java:34`, which points
   the agent at the exact file and line instead of making it search.
3. **Tools** — `list_files`, `read_file`, `search_code` (regex), so the agent pulls the
   source and the existing tests on demand.

For a repository this size, an embedding index or code graph would add infrastructure
without improving retrieval — the agent reaches the right file in two or three tool calls.
`search_code` is the seam: swapping its implementation for vector search or a code graph
requires no change to the agent loop, the prompt, or the tools contract.

The conventions being *in the repository* rather than in the prompt is the load-bearing
part. `AGENTS.md` says aggregation helpers return the neutral value for empty input rather
than throwing, so the agent produces the fix this codebase wants instead of a plausible
guess (a thrown domain exception, a `-1` sentinel, or a check at the call site).

### The orchestrator validates, not the agent

The agent has a `run_tests` tool and is told not to finish while tests fail. The
orchestrator then runs `mvn -B test` itself before opening a PR, and only opens one if
that run passes. A model's claim that tests pass is not evidence.

On failure the test output goes back to the agent for a bounded number of repair attempts
(`AGENT_MAX_REPAIR_ATTEMPTS`, default 2). If it still fails: no PR, and a failure email
saying human review is required.

A passing suite is also not sufficient on its own. The existing tests pass whether or not
`averageLineItemCents` guards the empty case, so a fix with no new test would validate
cleanly while proving nothing. The pipeline therefore requires the agent to have touched a
file under `src/test/` before a PR can open, and sends the change back asking for a
regression test if it has not. If the agent still does not add one, the PR opens carrying an
explicit reviewer warning rather than silently implying the change is proven.

This was found by running the pipeline repeatedly: one run produced a correct one-line fix
with no test, and the original validation accepted it.

### The agent works in a throwaway clone

Each incident gets a fresh shallow clone under `orchestrator/.agent-workspace/<incident>`.
The demo service is running from the working checkout during a demo; an agent editing
those files underneath it would be unsafe and unrepresentative. The clone is anonymous;
the PAT is used only in the push URL for a single call and is never written to
`.git/config`.

Tool paths are resolved against the workspace root and rejected if they escape it or
touch `.git` or `.env`.

### In-memory incident state

`status.js` holds the last 50 incidents in a `Map`. A POC restart should start clean.
Swapping in Redis or Postgres means reimplementing four functions.

## What was deliberately not built

| Not built | Why | Where it would go |
|---|---|---|
| Embedding / vector index | 8 source files; regex and file reads reach the target in a few calls | `search_code` in `agent/tools.js` |
| Code or knowledge graph | Same reason; no cross-service call graph to traverse | Same seam |
| Subscription filter → Lambda | Cannot run Maven/Git; local machine cannot receive AWS pushes | `cloudwatch.js` `onRecord` |
| Persistent incident store | Restart-clean is desirable for a POC | `status.js` |
| Human approval gate | Nothing merges automatically — the PR *is* the approval gate | Between validation and `openPullRequest` |
| Multi-repo / multi-service routing | One service, one repo | `config.github` becomes a lookup keyed by log group |
| Slack / PagerDuty channels | SMTP demonstrates the notification flow | Sibling module to `notifier.js` |

## Provider independence

`agent/llm.js` exposes one `chat({ system, messages, tools })` function over a neutral
message format. Two adapters cover three providers: OpenAI-compatible (OpenAI and Groq
share it, differing only by base URL) and Anthropic. `config.js` holds a provider table of
key variable, base URL and default model. Switching is two environment variables:

```bash
LLM_PROVIDER=openai      # openai | groq | anthropic
LLM_MODEL=gpt-5.4-mini
```

Adding a provider means a row in that table plus, only if its wire format differs, one
adapter. The agent loop, its tools and its prompt are untouched.

Provider quirks are absorbed here rather than leaking outward — OpenAI rejects
`reasoning_effort` alongside function tools on `/v1/chat/completions`, so the adapter drops
it there instead of failing every call in the loop.

## Failure handling

| Failure | Behaviour |
|---|---|
| CloudWatch unreachable from the app | Appender logs a warning and disables itself; the service keeps serving |
| Log group missing at orchestrator start | Warns once, keeps polling until the app creates it |
| LLM 429 / 5xx / timeout | Retried three times with backoff in `llm.js` |
| Agent modifies nothing | Workflow fails before committing; failure email sent |
| Tests fail | Bounded repair attempts, then no PR and a failure email |
| Fix has no regression test | Sent back for a test; if still absent, the PR opens with a reviewer warning |
| PR already exists for the branch | Existing PR is returned instead of erroring, so reruns are safe |
| Duplicate log delivery | Incidents deduplicated by incident ID; poller deduplicates by CloudWatch event ID |
| Two errors triggered at once | Agent runs are serialised through a promise queue |
