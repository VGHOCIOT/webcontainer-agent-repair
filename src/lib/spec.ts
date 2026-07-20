export const DEFAULT_SPEC = `Build a tiny Node.js HTTP server (no framework, use only the built-in "http" module — do not depend on express or any npm package) that serves a single paginated REST endpoint:

GET /items?page=<n>&limit=<n>

- Backed by an in-memory array of 47 items, each shaped like { id: number, name: string }, seeded on startup (e.g. "Item 1".."Item 47").
- "page" defaults to 1, "limit" defaults to 10. Both are positive integers; reject (400) anything else.
- Response JSON shape:
  { "page": <n>, "limit": <n>, "total": 47, "items": [ ... ] }
- "items" must contain the correct slice for that page/limit, and must never include items from adjacent pages (no off-by-one).
- Requesting a page beyond the last page returns an empty "items" array with 200, not an error.
- The server must listen on process.env.PORT (fall back to 3000 if unset) and log "Server ready" once listening.

Keep it to one file, index.js, plus a minimal package.json with a "start" script that runs "node index.js".`;

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
