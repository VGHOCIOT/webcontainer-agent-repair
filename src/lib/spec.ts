export const DEFAULT_SPEC = `Build a tiny Node.js HTTP server using only the built-in "http" module (no express or other npm packages) that serves one paginated REST endpoint:

GET /items?page=<n>&limit=<n>

- It returns items from an in-memory list of 47 records, each shaped { id: number, name: string } ("Item 1" through "Item 47"), seeded on startup.
- "page" defaults to 1 and "limit" defaults to 10. Invalid values for either are a client error.
- The response body is JSON: { page, limit, total, items }, where "items" holds the records for the requested page.
- Requesting a page past the end is not an error.
- Listen on process.env.PORT (or 3000) and log "Server ready" once listening.

Keep it to one index.js plus a minimal package.json whose "start" script runs "node index.js".`;

// A second preset that renders an actual UI in the preview pane (not just JSON),
// so the demo shows a recognizable little frontend app healing — while still
// being HTTP-probeable by a deterministic validator (the served HTML + the JSON
// API it fetches).
export const FRONTEND_SPEC = `Build a tiny Node.js HTTP server using only the built-in "http" module (no express or other npm packages) that serves a minimal single-page "task list" app:

- GET / returns an HTML page (Content-Type: text/html) with a heading "Tasks" and an empty <ul id="list">. The page includes a small inline <script> that fetches /api/tasks and renders one <li> per task showing its title; a task whose "done" is true is rendered with a line-through style.
- GET /api/tasks returns JSON (Content-Type: application/json): an array of about 5 seeded tasks, each shaped { id: number, title: string, done: boolean }, with at least one done and one not done.
- Anything else returns 404.
- Listen on process.env.PORT (or 3000) and log "Server ready" once listening.

Keep it to one index.js (you may inline the HTML and client script) plus a minimal package.json whose "start" script runs "node index.js".`;

export const SYSTEM_PROMPT = `You are a backend code generator operating inside an automated write-run-fix loop. You do not talk to the end user directly — your entire response is parsed by a script and written to disk verbatim, so it must contain nothing but file blocks.

Output format (strict): for every file you want to write, emit a block exactly like this:

\`\`\`file:path/to/file.js
<full file contents>
\`\`\`

Rules:
- No prose before, between, or after the file blocks. No explanations, no markdown headings.
- Always output the FULL contents of every file you are creating or changing, never a diff or partial snippet.
- Only write the files needed to satisfy the spec (typically index.js and package.json).
- package.json must be valid JSON with a "start" script.
- If you are given a previous attempt's error output, treat it as ground truth about what actually happened when the code ran — read it carefully and fix the specific failure, rather than rewriting the app from scratch.`;

export function buildRetryPrompt(spec: string, errorReport: string): string {
  return `The previous attempt failed. Here is what actually happened when it ran:

${errorReport}

Fix the code so it satisfies the original spec:

${spec}

Output the corrected file(s) in full, using the required file-block format.`;
}

/**
 * Used when the loop detects no progress — the last attempt's files were
 * byte-identical, or it reproduced the exact same failure. A plain retry
 * prompt tends to reproduce the same output, so this one names the stall
 * explicitly and demands a materially different approach.
 */
export function buildEscalatedRetryPrompt(
  spec: string,
  errorReport: string,
  reason: string,
): string {
  return `STOP repeating yourself. ${reason} Simply re-emitting the same code (or the same fix) will not work — you must change your APPROACH, not just retype it. Re-read the error below and reconsider the root cause from scratch.

Here is what actually happened when the last attempt ran:

${errorReport}

Satisfy the original spec:

${spec}

Output the corrected file(s) in full, using the required file-block format.`;
}
