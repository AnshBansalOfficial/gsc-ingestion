# AI-Assisted Java Development — Proof of Concept

An application error in a running Java service becomes a validated GitHub pull request,
with no human in the loop.

```
Frontend → Java service → CloudWatch Logs → Classification ─┬─ ALERT → email
                                                            │
                                                            └─ ERROR → email #1
                                                                       → AI agent
                                                                       → codebase understanding
                                                                       → code fix
                                                                       → mvn test
                                                                       → GitHub PR
                                                                       → email #2
```

Everything in that diagram is real: logs genuinely reach AWS CloudWatch, the agent
genuinely reads and edits the repository, tests genuinely run, and the pull request is a
real PR you can open on GitHub.

## What's in here

| Path | What it is |
|---|---|
| `demo-app/` | Java 17 / Spring Boot service. Emits alert and error signals, ships every log to CloudWatch, and contains the deliberate defect the agent fixes. |
| `demo-app/src/main/resources/static/index.html` | The demo frontend — two buttons and a live pipeline timeline. |
| `orchestrator/` | Node.js pipeline: tails CloudWatch, classifies events, runs the AI agent, validates, opens the PR, sends the emails. |
| `AGENTS.md` | Repository instructions the AI agent reads before changing code. |
| `docs/ARCHITECTURE.md` | Why it is built this way, and what changes for production. |
| `.env.example` | Every variable the system needs. |

## The deliberate defect

`InvoiceService.averageLineItemCents()` divides the invoice total by
`invoice.items().size()`. A draft invoice with no line items is a valid domain state, so
the call throws `ArithmeticException: / by zero`.

`POST /api/error` exercises exactly that path. The stack trace that reaches CloudWatch
names the file and line, which is how the agent locates the defect.

The fix is deliberately small. The point of the POC is the pipeline around it.

## Prerequisites

- Java 17 and Maven
- Node.js 20+
- An AWS account with credentials configured (`aws configure`) — only CloudWatch Logs
  permissions are needed
- A GitHub fine-grained PAT with **Contents: read/write** and **Pull requests: read/write**
- An SMTP account (Gmail app password works)
- An LLM API key (OpenAI, Groq, or Anthropic)

## Setup

```bash
cp .env.example .env     # then fill in the values
cd orchestrator && npm install && cd ..
```

`.env` is gitignored. Nothing in this repo reads credentials from anywhere else, and AWS
credentials come from the standard AWS chain rather than from `.env`.

### Environment variables

| Variable | Purpose |
|---|---|
| `AWS_REGION` | Region for the log group, e.g. `ap-south-1` |
| `CW_LOG_GROUP` | Log group name, created automatically on first run |
| `LLM_PROVIDER` | `openai`, `groq`, or `anthropic` |
| `LLM_MODEL` | e.g. `gpt-5.4-mini`, `openai/gpt-oss-120b`, `claude-sonnet-5` |
| `OPENAI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | Key for the selected provider |
| `GITHUB_TOKEN` | Fine-grained PAT |
| `GITHUB_REPO` | `owner/repo` |
| `GITHUB_BASE_BRANCH` | PR base branch, e.g. `master` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | Mail transport |
| `NOTIFY_EMAIL_TO` | Where notifications go |
| `APP_PORT` / `ORCHESTRATOR_PORT` | Defaults 8080 / 8090 |

Optional knobs: `POLL_INTERVAL_MS`, `POLL_FROM` (`now` \| `lookback` \| `beginning`),
`AGENT_MAX_ITERATIONS`, `AGENT_MAX_REPAIR_ATTEMPTS`, `SMTP_ENABLED=false` to rehearse
without sending mail, `LLM_BASE_URL` to point at any OpenAI-compatible endpoint.

## Running it

Two terminals.

```bash
# terminal 1 — the Java service
set -a; . ./.env; set +a
cd demo-app && mvn spring-boot:run
```

```bash
# terminal 2 — the orchestrator
cd orchestrator && npm start
```

The orchestrator verifies GitHub push access and SMTP login at startup, so a broken
credential fails immediately rather than halfway through a demo.

Then open **http://localhost:8080**.

## Demo script

1. **Open the frontend.** The chips along the top show the live log group, model, and
   target repository.
2. **Click "Send Alert".** A `WARN` log reaches CloudWatch, the classifier marks it
   `ALERT`, and one email arrives. The AI agent is not invoked — that is the point of
   having a classification step.
3. **Click "Simulate Error".** The service throws, an `ERROR` log with a stack trace
   reaches CloudWatch, and the classifier marks it `ERROR`.
4. **Show email #1** — "the AI agent is investigating".
5. **Watch the timeline.** The agent clones the repo, reads `AGENTS.md`, follows the
   stack frame to the source, reads the tests, writes the fix, adds a regression test and
   runs `mvn test`. Each tool call appears live.
6. **Open the pull request** from the link on the card, and show the branch, commit and
   diff on GitHub.
7. **Show email #2** — the fix is validated and the PR URL is included.

Show the logs in the AWS console at any point:
**CloudWatch → Log groups → `/gsc-poc/demo-app`**.

Or from the CLI:

```bash
aws logs tail /gsc-poc/demo-app --since 10m
```

### How long a run takes

Measured end to end, from clicking *Simulate Error* to the PR appearing:

| Provider / model | Time | Notes |
|---|---|---|
| `openai` / `gpt-5.4-mini` | **~50 s** | No rate limiting. 7 tool calls. Recommended. |
| `groq` / `openai/gpt-oss-120b` | 2–10 min | Free, but capped at 8,000 tokens/minute — most of the time is spent waiting on the quota, and run-to-run variance is high. |

Switching provider is two variables in `.env`:

```bash
LLM_PROVIDER=openai      # or groq, or anthropic
LLM_MODEL=gpt-5.4-mini
```

Email #1 exists precisely so the recipient is not staring at a silent system while the
agent works — which matters much more on the free tier than on a paid key.

### Repeating the demo

Do not merge the PR — merging removes the defect and the next run has nothing to fix.
Close the PRs and delete the `ai-fix/*` branches between rehearsals, or just leave them;
each run gets its own incident ID and its own branch.

## End-to-end test without the UI

```bash
set -a; . ./.env; set +a
curl -X POST http://localhost:8080/api/alert     # -> ALERT path
curl -X POST http://localhost:8080/api/error     # -> ERROR path, opens a PR
curl -s http://localhost:8090/status | python3 -m json.tool
```

## Notes on scope

This is a POC, not production software. `docs/ARCHITECTURE.md` records the decisions that
were deliberately kept simple — polling instead of a subscription filter, in-memory
incident state, regex-and-file-read code retrieval instead of an embedding index — and
where each one would be replaced.
