# Repository instructions for automated engineering agents

Read this before changing any code.

## Layout

| Path | Purpose |
|---|---|
| `demo-app/` | Java 17 / Spring Boot service. **The only module an agent may modify.** |
| `demo-app/src/main/java/com/gsc/poc/service/` | Business logic (invoice pricing) |
| `demo-app/src/main/java/com/gsc/poc/model/` | Immutable records — check their javadoc for intended behaviour |
| `demo-app/src/main/java/com/gsc/poc/web/` | HTTP endpoints |
| `demo-app/src/main/java/com/gsc/poc/logging/` | CloudWatch appender — infrastructure, never the fix for a business bug |
| `demo-app/src/test/java/` | JUnit 5 tests |
| `orchestrator/` | Node.js pipeline. Not application code. Do not modify. |

## Conventions

- **Money** is always `int` cents. Never `float`, `double` or `BigDecimal`.
- **Empty collections.** Pricing and aggregation helpers must tolerate empty input. An
  invoice with zero line items is a valid domain state (a draft), not an error. Such
  helpers return the neutral value — `0` for a sum or an average — and must never throw.
  Do not instead: make callers avoid the call, return a sentinel like `-1`, or throw a
  domain exception.
- **Nulls.** `Invoice.items()` is never null. Do not add null checks for it.
- **Records** stay immutable and free of logic.
- No comments that restate the code. No `TODO` markers.

## Changing code

Make the smallest change that fixes the reported problem. Do not reformat, reorder
imports, rename symbols, or upgrade dependencies. Do not touch `pom.xml`,
`orchestrator/`, `README.md`, `.env*` or CI config when fixing an application defect.

## Tests

Every behaviour change needs a test, added to the existing test file in the existing
style: plain JUnit 5, `@DisplayName` on each test, the class under test instantiated
directly (no Spring context — the suite must run without AWS credentials).

Run: `cd demo-app && mvn -q -B test`. The suite must pass before a pull request opens.

## Pull requests

Branch from `master` as `ai-fix/<incident-id>`. Title: short imperative summary. Body:
incident context, root cause, the change, and test results.
