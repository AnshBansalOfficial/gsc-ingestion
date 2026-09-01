import { config } from '../config.js';

/**
 * Provider-agnostic chat-with-tools client.
 *
 * The agent loop speaks one neutral message format; each provider adapter translates it.
 * Adding a provider means adding one `toRequest`/`fromResponse` pair — no change to the
 * agent, its tools or its prompt.
 *
 * Neutral message shapes:
 *   { role: 'user'|'assistant', content: string }
 *   { role: 'assistant', content: string, toolCalls: [{ id, name, args }] }
 *   { role: 'tool', toolCallId, name, content: string }
 */

const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180_000);
const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 8);
const MAX_BACKOFF_MS = 65_000;

export async function chat({ system, messages, tools }) {
  const provider = PROVIDERS[config.llm.provider];
  if (!provider) {
    throw new Error(`Unknown LLM_PROVIDER "${config.llm.provider}" (supported: ${Object.keys(PROVIDERS).join(', ')})`);
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await provider.call({ system, messages, tools });
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
      const waitMs = retryDelayMs(err, attempt);
      console.warn(`[llm] ${firstLine(err.message)} — retrying in ${Math.round(waitMs / 1000)}s `
        + `(attempt ${attempt}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

function isRetryable(err) {
  return /\b(429|500|502|503|504)\b/.test(err.message) || /timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(err.message);
}

/**
 * Rate limit responses say exactly how long to wait ("try again in 16.47s", or a
 * Retry-After header). Honouring that is the difference between recovering and burning
 * every retry on a window that has not reopened yet — a fixed short backoff simply fails
 * three times against a per-minute token quota.
 */
function retryDelayMs(err, attempt) {
  const advised = err.retryAfterMs
    ?? parseAdvisedWait(err.message);
  if (advised != null) {
    return Math.min(advised + 750, MAX_BACKOFF_MS);
  }
  return Math.min(2000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

function parseAdvisedWait(message) {
  const seconds = message.match(/try again in ([\d.]+)s/i);
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  const minutes = message.match(/try again in ([\d.]+)m([\d.]+)?s?/i);
  if (minutes) return Math.ceil(Number(minutes[1]) * 60_000);
  return null;
}

function firstLine(text) {
  return String(text).split('\n')[0].slice(0, 220);
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`LLM HTTP ${response.status}: ${text.slice(0, 600)}`);
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = Math.ceil(Number(retryAfter) * 1000);
    throw err;
  }
  return JSON.parse(text);
}

// --- OpenAI-compatible (Groq, and any OpenAI-shaped endpoint) ---------------------

const openAiCompatible = {
  async call({ system, messages, tools }) {
    const payload = {
      model: config.llm.model,
      temperature: 0.1,
      // Reasoning tokens count against a provider's token quota, so the effort level is
      // configurable — 'low' keeps an agent loop inside a small per-minute budget.
      // OpenAI rejects reasoning_effort alongside function tools on /v1/chat/completions,
      // so it is dropped there rather than failing every call in the agent loop.
      ...(process.env.LLM_REASONING_EFFORT && !(config.llm.provider === 'openai' && tools?.length)
        ? { reasoning_effort: process.env.LLM_REASONING_EFFORT }
        : {}),
      messages: [
        { role: 'system', content: system },
        ...messages.map((m) => {
          if (m.role === 'tool') {
            return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
          }
          if (m.toolCalls?.length) {
            return {
              role: 'assistant',
              content: m.content || '',
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            };
          }
          return { role: m.role, content: m.content };
        }),
      ],
    };
    if (tools?.length) {
      payload.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
      payload.tool_choice = 'auto';
    }

    const data = await postJson(`${config.llm.baseUrl}/chat/completions`, {
      authorization: `Bearer ${config.llm.apiKey}`,
    }, payload);

    const message = data.choices?.[0]?.message || {};
    return {
      text: message.content || '',
      toolCalls: (message.tool_calls || []).map((c) => ({
        id: c.id,
        name: c.function?.name,
        args: safeParseArgs(c.function?.arguments),
      })),
      usage: data.usage || null,
    };
  },
};

// --- Anthropic ------------------------------------------------------------------

const anthropic = {
  async call({ system, messages, tools }) {
    const payload = {
      model: config.llm.model,
      max_tokens: 8192,
      temperature: 0.1,
      system,
      messages: toAnthropicMessages(messages),
    };
    if (tools?.length) {
      payload.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }

    const data = await postJson('https://api.anthropic.com/v1/messages', {
      'x-api-key': config.llm.apiKey,
      'anthropic-version': '2023-06-01',
    }, payload);

    const blocks = data.content || [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, name: b.name, args: b.input || {},
      })),
      usage: data.usage || null,
    };
  },
};

/**
 * Anthropic requires every tool_result for one assistant turn to arrive in a single user
 * message, so consecutive neutral `tool` messages are grouped.
 */
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.toolCalls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function safeParseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsed: String(raw) };
  }
}

const PROVIDERS = { groq: openAiCompatible, openai: openAiCompatible, anthropic };

export { PROVIDERS };
