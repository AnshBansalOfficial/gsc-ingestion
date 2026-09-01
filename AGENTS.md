# Repository instructions for automated engineering agents

Read this file before changing any code. It describes the layout, the conventions this
codebase follows, and how to validate a change.

## Repository map

| Path | Purpose |
|---|---|
| `demo-app/` | Java 17 / Spring Boot service. **This is the only module an agent should modify.** |
| `demo-app/src/main/java/com/gsc/poc/web/` | HTTP endpoints that emit application signals |
| `demo-app/src/main/java/com/gsc/poc/service/` | Business logic (invoice pricing) |
| `demo-app/src/main/java/com/gsc/poc/model/` | Immutable records |
| `demo-app/src/main/java/com/gsc/poc/logging/` | CloudWatch Logs appender — infrastructure, do not change to fix a business bug |
| `demo-app/src/test/java/` | JUnit 5 tests |
| `orchestrator/` | Node.js pipeline that reads CloudWatch, classifies events and runs the agent. Not application code. |

## Conventions

**Money.** All monetary values are `int` amounts in **cents** (minor units). Never
introduce `float`, `double` or `BigDecimal` into pricing code.

**Empty collections.** Pricing and aggregation helpers must tolerate empty input. An
invoice with zero line items is a valid domain state (a draft invoice), not an error
condition. Such helpers return the neutral value — `0` for a sum or an average — and must
never throw. Do not "fix" this class of bug by making callers avoid the call, by
returning a sentinel like `-1`, or by throwing a domain exception.

**Nulls.** `Invoice.items()` is never null. Do not add null checks for it.

**Records.** Model types are Java records. Keep them immutable and free of logic.

**Comments.** Explain intent where it is not obvious. Do not add comments that restate
the code, and do not leave `TODO` markers behind.

## Changing code

- Make the **smallest change that fixes the reported problem**. Do not reformat
  surrounding code, reorder imports, rename symbols, or upgrade dependencies.
- Do not touch `pom.xml` unless the fix genuinely requires a new dependency.
- Do not modify `orchestrator/`, `README.md`, `.env*`, or CI configuration when fixing an
  application defect.

## Tests

Every behaviour change needs a test. Add tests next to the existing ones in
`demo-app/src/test/java/com/gsc/poc/...`, following the existing style: plain JUnit 5,
`@DisplayName` on each test, direct instantiation of the class under test (no Spring
context — the suite must run without AWS credentials).

Validate with:

```bash
cd demo-app && mvn -q -B test
```

The full suite must pass before a pull request is opened.

## Pull requests

- Branch from `master`, named `ai-fix/<incident-id>`.
- Title: short imperative summary of the fix.
- Body: the incident context, the root cause, the change made, and the test results.
