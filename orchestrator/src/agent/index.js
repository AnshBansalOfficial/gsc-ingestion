import { config } from '../config.js';
import { chat } from './llm.js';
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

  for (let iteration = 1; iteration <= config.llm.maxIterations; iteration++) {
    const response = await chat({ system: SYSTEM_PROMPT, messages, tools: tools.definitions });

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
        content: result.content.slice(0, 30_000),
      });
    }
  }

  return {
    finalText,
    report: parseReport(finalText),
    changedFiles: [...tools.writtenFiles],
    toolLog,
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
