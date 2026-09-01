import { config } from '../config.js';
import { chat } from './llm.js';

/**
 * Tool output is capped and older output is pruned from the history.
 *
 * An agent loop resends its whole conversation on every call, so an uncapped transcript
 * grows quadratically in tokens and will exhaust a per-minute token quota within a few
 * steps. Recent output is what the model is reasoning about; older output can be
 * re-fetched with the same tool call if it is needed again.
 */
const TOOL_RESULT_MAX_CHARS = Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS || 6000);
const FULL_TOOL_RESULTS_KEPT = Number(process.env.AGENT_FULL_TOOL_RESULTS_KEPT || 3);
import { createTools, formatTestResult } from './tools.js';
import { SYSTEM_PROMPT, buildIncidentMessage } from './prompt.js';

/**
 * Runs the engineering agent against a workspace checkout.
 *
 * Returns what happened rather than deciding what to do next — the pipeline owns the
 * decision to open a pull request, and re-validates the tests itself before doing so.
 */
export async function runAgent({ incident, workspaceDir, onProgress = () => {} }) {
  const tools = createTools(workspaceDir, {
    onToolEvent: ({ name, args }) => {
      const target = args?.path || args?.dir || args?.pattern || '';
      onProgress({ type: 'tool', name, target: String(target).slice(0, 90) });
    },
  });

  const messages = [{ role: 'user', content: buildIncidentMessage(incident) }];
  const toolLog = [];
  let finalText = '';
  let noEditNudges = 0;

  let totalTokens = 0;

  for (let iteration = 1; iteration <= config.llm.maxIterations; iteration++) {
    pruneOldToolResults(messages);
    const response = await chat({ system: SYSTEM_PROMPT, messages, tools: tools.definitions });
    totalTokens += response.usage?.total_tokens || 0;

    if (response.toolCalls.length === 0) {
      const text = (response.text || '').trim();

      // A model that declares victory without editing anything has not done the job.
      if (tools.writtenFiles.size === 0 && noEditNudges < 2) {
        noEditNudges++;
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: 'You have not modified any file yet. Locate the defect, apply the fix with '
            + 'write_file, add a regression test, and run run_tests before reporting.',
        });
        continue;
      }
      finalText = text;
      break;
    }

    messages.push({ role: 'assistant', content: response.text || '', toolCalls: response.toolCalls });

    for (const call of response.toolCalls) {
      const result = await tools.execute(call.name, call.args);
      toolLog.push({ name: call.name, args: call.args, ok: result.ok });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: truncate(result.content, TOOL_RESULT_MAX_CHARS),
      });
    }
  }

  return {
    finalText,
    report: parseReport(finalText),
    changedFiles: [...tools.writtenFiles],
    toolLog,
    totalTokens,
    /** Lets the pipeline re-run the suite authoritatively. */
    runTests: tools.runTests,
  };
}

/**
 * Feeds a failing test run back to the agent for another attempt.
 * Kept deliberately simple: same loop, extra context, bounded by maxRepairAttempts.
 */
export async function runRepair({ incident, workspaceDir, testResult, onProgress }) {
  const repairIncident = {
    ...incident,
    message: `${incident.message}\n\nA previous fix attempt did not pass the test suite.`,
  };
  const result = await runAgent({
    incident: repairIncident,
    workspaceDir,
    onProgress,
  });
  return result;
}

/**
 * Collapses all but the most recent tool results to a one-line placeholder, in place.
 * The model is told it can re-run the tool, so nothing is unrecoverable.
 */
function pruneOldToolResults(messages) {
  const toolIndexes = [];
  messages.forEach((m, i) => { if (m.role === 'tool') toolIndexes.push(i); });

  const stale = toolIndexes.slice(0, Math.max(0, toolIndexes.length - FULL_TOOL_RESULTS_KEPT));
  for (const i of stale) {
    const m = messages[i];
    if (m.pruned || m.content.length < 200) continue;
    m.content = `[earlier output of ${m.name} omitted to conserve context — run the tool again if you need it]`;
    m.pruned = true;
  }
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated, ${text.length - maxChars} more characters]`;
}

function parseReport(text) {
  const field = (label) => {
    // No 'm' flag: with it, `$` would match the first line break and truncate
    // multi-line values. The alternation handles a label at the very start of the text.
    const match = text.match(new RegExp(`(?:^|\\n)${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z ]{2,}:|$)`));
    return match ? match[1].trim() : null;
  };
  return {
    title: field('TITLE'),
    rootCause: field('ROOT CAUSE'),
    change: field('CHANGE'),
    tests: field('TESTS'),
    raw: text,
  };
}

export { parseReport, formatTestResult };
