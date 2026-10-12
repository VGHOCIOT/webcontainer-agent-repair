import Anthropic from "@anthropic-ai/sdk";

export interface GeneratedDriver {
  driverBody: string;
  checkNames: string[];
  inputTokens: number;
  outputTokens: number;
}

// The interaction driver is the *frontend* grader's authored-once half (Mode A,
// same as the loopback validator): the strong model reads the spec and writes a
// deterministic `runChecks()` that the harness (previewDriver.ts) then runs
// unchanged inside the preview every attempt. It sees the real rendered DOM and
// real user interactions — the layer no loopback check can reach.
//
// The harness supplies these globals, so the driver must NOT redefine them,
// wrap itself in an IIFE, or call postMessage — it only defines runChecks():
//   $(sel)               -> first matching element or null
//   $all(sel)            -> array of matching elements
//   waitFor(pred, ms)    -> polls pred() until truthy or timeout; resolves boolean
//   setInput(el, value)  -> sets an <input>/<textarea> value and fires input+change
//   click(el)            -> clicks el if present
//   struck(el)           -> true if el or any descendant has line-through styling
// plus the normal DOM (document, getComputedStyle, …). The page is already
// loaded at the app's representative page when runChecks() runs.
export const DRIVER_SYSTEM_PROMPT = `You write a deterministic browser interaction driver for a small single-page web app, given only its spec. Your driver is the ground-truth FRONTEND grader in an automated write-run-fix loop: the app's code generator never sees your driver, so exercise the real UI — click, type, toggle — and assert on the resulting DOM, catching behavior that the served HTML alone does not reveal.

The driver runs inside the already-loaded page. A harness provides these globals — use them, do NOT redefine them:
- check(name, fn): runs one named assertion. await check("...", async () => { ... }). If fn throws, that becomes a FAILED check with the error as its detail; if fn returns a string it's the pass detail. THROW to fail a check (e.g. throw new Error("expected X, got Y")); this is the primary way to record a check. Using check() is REQUIRED — it isolates each assertion so one failure never aborts the others.
- $(sel): first matching element or null
- $all(sel): array of matching elements
- waitFor(pred, ms): polls pred() until it returns truthy or ms elapses; resolves to a boolean. Use it for anything asynchronous (initial render, post-click updates) instead of fixed sleeps.
- setInput(el, value): sets an <input>/<textarea> value and dispatches input+change (needed for framework-bound inputs)
- click(el): clicks el if present
- struck(el): true if el or any descendant is styled with line-through
You may also use normal DOM APIs (document, getComputedStyle, etc.).

Output EXACTLY two fenced code blocks and nothing else — no prose before, between, or after them:

1. A \`\`\`json block: an array of the check names (short readable strings) your driver emits, in order.
2. A \`\`\`javascript block: the body defining exactly \`async function runChecks() { ... }\`. Do NOT wrap it in an IIFE, do NOT redefine the harness globals, do NOT call postMessage — only define runChecks.

The runChecks contract:
- Record EVERY assertion via \`await check(name, async () => { ... })\`. Inside the fn, throw an Error to fail (with a message saying expected-vs-actual); return a short string to pass. Do not build your own results array and do not return anything — the harness collects the checks.
- Use waitFor for every asynchronous expectation (the initial data render, the DOM change after an interaction), with a sensible timeout, then throw if it didn't happen.
- Because each check is isolated by check(), you do NOT need defensive null-guards around the whole flow — a missing element throwing inside one check just fails that check. Still, prefer clear expected-vs-actual messages.
- Derive checks from the spec: the initial render from data, each user interaction the spec describes, and the observable DOM outcome of each. Prefer several small named checks over one big one so a partial fix is visible. Assert against real behavior, not just values quoted in the spec, and use the concrete ids/structure the spec states.
- If the spec has no interactive UI to drive (e.g. a pure JSON API), emit a single check: await check("no-interactive-ui", async () => "spec has no interactive UI to drive").

Worked example — for a spec: "GET / serves a page with a heading Tasks, an <input id='new-task'>, a <button id='add'>, and an empty <ul id='list'>. On load the inline script fetches GET /api/tasks (array of { id, title, done }) and renders one <li> per task with a checkbox and the title; a done task's title has line-through. Clicking add appends a task titled with the input's text and clears the input; toggling a checkbox flips its line-through.":

\`\`\`json
["renders seeded tasks", "add appends a task row", "input clears after add", "toggle flips line-through"]
\`\`\`

\`\`\`javascript
async function runChecks() {
  let initial = 0;
  await check("renders seeded tasks", async () => {
    const ok = await waitFor(() => $all("#list li").length >= 1, 5000);
    if (!ok) throw new Error("no <li> under #list within 5s");
    initial = $all("#list li").length;
    return \`rendered \${initial} task row(s)\`;
  });

  await check("add appends a task row", async () => {
    const input = $("#new-task");
    const addBtn = $("#add");
    if (!input || !addBtn) throw new Error("missing #new-task or #add");
    const title = "Buy oat milk " + Date.now();
    setInput(input, title);
    click(addBtn);
    const appended = await waitFor(() => $all("#list li").length === initial + 1, 2500);
    if (!appended) throw new Error("Add did not append a new <li>");
    const last = $all("#list li").slice(-1)[0];
    if (!(last && (last.textContent || "").includes(title)))
      throw new Error("new row does not show the typed title");
    return "Add appended a row showing the typed title";
  });

  await check("input clears after add", async () => {
    const input = $("#new-task");
    const cleared = await waitFor(() => input && input.value === "", 1000);
    if (!cleared) throw new Error('input still holds "' + (input ? input.value : "?") + '"');
    return "input cleared after Add";
  });

  await check("toggle flips line-through", async () => {
    const firstLi = $all("#list li")[0];
    const box = firstLi ? firstLi.querySelector("input[type=checkbox]") : null;
    if (!box) throw new Error("no checkbox in first row");
    const before = struck(firstLi);
    click(box);
    const toggled = await waitFor(() => struck(firstLi) !== before, 1500);
    if (!toggled) throw new Error("toggling did not change the line-through style");
    return "toggling changed the line-through state";
  });
}
\`\`\``;

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)```/;
// Closing fence optional: a response truncated at max_tokens still has a usable opening fence.
const JS_BLOCK_RE = /```(?:javascript|js)\s*\n([\s\S]*?)(?:```|$)/;

/**
 * Mode A for the frontend grader: one AI call turns a freeform spec into a
 * deterministic interaction driver body (`runChecks`). The loop then runs that
 * fixed driver inside the preview every attempt, so the grader stays
 * deterministic at run time — only its authoring uses the model.
 */
export async function generateDriver(
  apiKey: string,
  model: string,
  spec: string,
): Promise<GeneratedDriver> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: DRIVER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Spec:\n\n${spec}` }],
  });

  const rawText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const bodyMatch = rawText.match(JS_BLOCK_RE);
  if (!bodyMatch) {
    throw new Error(
      `Driver generation did not return a JavaScript code block (stop_reason: ${response.stop_reason}). Try Regenerate. Response began: ${rawText.slice(0, 200) || "(empty)"}`,
    );
  }
  const driverBody = bodyMatch[1].trimEnd();

  // Check names are best-effort: they only drive the pre-run panel display. The
  // real names arrive from the driver's runtime output on the first attempt.
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
    driverBody,
    checkNames,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
