import Anthropic from "@anthropic-ai/sdk";

export interface GeneratedValidator {
  script: string;
  checkNames: string[];
  inputTokens: number;
  outputTokens: number;
}

// The output contract every validator must honor, plus a full worked example
// (the /items pagination checks that used to live hard-coded in validate.ts).
// The example teaches the model three things at once: the exact stdout shape we
// parse, that each assertion is a *named* check (so the UI can track it healing
// across attempts), and the expected thoroughness — boundary and invalid-input
// cases, tested against held-out values the code generator never sees.
export const VALIDATOR_SYSTEM_PROMPT = `You write a deterministic validator for a small server app, given only its spec. Your validator is the ground-truth grader in an automated write-run-fix loop: the app's code generator never sees your validator, so probe it with concrete requests and check real behavior, not just the exact values quoted in the spec.

Output EXACTLY two fenced code blocks and nothing else — no prose before, between, or after them:

1. A \`\`\`json block: an array of the check names (kebab-case strings) your validator emits, in order.
2. A \`\`\`javascript block: a self-contained Node ESM script (it will be saved as a .mjs file).

The script contract:
- It receives the server's port as process.argv[2] and talks to http://localhost:<port>.
- It uses only built-in Node APIs (global fetch, no imports, no npm packages).
- It runs a series of independent named checks. Each check pushes { name, pass, details } to a results array. "details" is a short human-readable explanation, especially of what was expected vs. what actually happened on failure.
- A network/connection error or an unexpected exception inside a check is a FAILED check for that name (details = the error message), never an uncaught crash.
- As its LAST line of stdout it prints exactly: console.log(JSON.stringify({ checks: results }))
- No other stdout. Do not print progress logs.

Derive checks that pin down correctness thoroughly: happy path, boundaries (first/last/past-the-end), and invalid input (expected error status). Prefer several small named checks over one big one, so a partial fix is visible.

Worked example — for the spec "GET /items?page&limit paginated over 47 in-memory items, default page 1 limit 10, positive integers only (else 400), shape { page, limit, total, items }, past-the-last-page returns empty items with 200":

\`\`\`json
["page-1-slice", "total-count", "page-2-no-overlap", "past-end-empty", "invalid-param-400"]
\`\`\`

\`\`\`javascript
const base = \`http://localhost:\${process.argv[2]}\`;
const results = [];

async function getJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, fn) {
  try {
    const details = await fn();
    results.push({ name, pass: true, details: details ?? "ok" });
  } catch (err) {
    results.push({ name, pass: false, details: err.message });
  }
}

await check("page-1-slice", async () => {
  const { status, body } = await getJson(\`\${base}/items?page=1&limit=5\`);
  if (status !== 200) throw new Error(\`expected 200, got \${status}\`);
  const ids = (body?.items ?? []).map((i) => i.id);
  if (ids.join(",") !== "1,2,3,4,5") throw new Error(\`expected ids 1..5, got [\${ids.join(",")}]\`);
  return "page 1 returns items 1..5";
});

await check("total-count", async () => {
  const { body } = await getJson(\`\${base}/items?page=1&limit=5\`);
  if (body?.total !== 47) throw new Error(\`expected total=47, got \${body?.total}\`);
  return "total is 47";
});

await check("page-2-no-overlap", async () => {
  const { body } = await getJson(\`\${base}/items?page=2&limit=5\`);
  const ids = (body?.items ?? []).map((i) => i.id);
  if (ids.join(",") !== "6,7,8,9,10") throw new Error(\`expected ids 6..10, got [\${ids.join(",")}]\`);
  return "page 2 does not overlap page 1";
});

await check("past-end-empty", async () => {
  const { status, body } = await getJson(\`\${base}/items?page=100&limit=5\`);
  if (status !== 200) throw new Error(\`expected 200, got \${status}\`);
  if (!Array.isArray(body?.items) || body.items.length !== 0)
    throw new Error(\`expected empty items, got \${JSON.stringify(body?.items)}\`);
  return "past the last page is empty with 200";
});

await check("invalid-param-400", async () => {
  const { status } = await getJson(\`\${base}/items?page=abc\`);
  if (status !== 400) throw new Error(\`expected 400 for non-numeric page, got \${status}\`);
  return "non-numeric page is rejected with 400";
});

console.log(JSON.stringify({ checks: results }));
\`\`\``;

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)```/;
const JS_BLOCK_RE = /```(?:javascript|js)\s*\n([\s\S]*?)```/;

/**
 * Mode A: one AI call turns a freeform spec into a deterministic validator
 * script. The loop then runs that fixed script every attempt, so the grader
 * stays deterministic at run time — only its authoring uses the model.
 */
export async function generateValidator(
  apiKey: string,
  model: string,
  spec: string,
): Promise<GeneratedValidator> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: VALIDATOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Spec:\n\n${spec}` }],
  });

  const rawText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const scriptMatch = rawText.match(JS_BLOCK_RE);
  if (!scriptMatch) {
    throw new Error(
      "Validator generation did not return a JavaScript code block. Try Regenerate.",
    );
  }
  const script = scriptMatch[1].trimEnd();

  // Check names are best-effort: they only drive the pre-run panel display.
  // If the json block is missing or malformed, fall back to empty — the real
  // names arrive from the validator's runtime output on the first attempt.
  let checkNames: string[] = [];
  const jsonMatch = rawText.match(JSON_BLOCK_RE);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === "string")) {
        checkNames = parsed;
      }
    } catch {
      // leave checkNames empty
    }
  }

  return {
    script,
    checkNames,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
