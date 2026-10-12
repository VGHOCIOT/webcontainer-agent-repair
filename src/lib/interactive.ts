// A Tier-2 spec whose difficulty lives in the FRONTEND, not the data layer: the
// server is a dumb in-memory stub, but the page has real client behavior (add a
// task, clear the input, toggle done -> line-through). None of that is
// observable over loopback HTTP — it only exists once the browser runs the
// page's script and a user interacts — which is exactly what the interaction
// driver grades (authored from this spec by driverGen). The spec is deliberately
// loose (no bug-coaching); a weaker builder tends to miss one of the
// interactions (forgets to clear the input, wires the toggle without restyling,
// appends without the title), and that bug then surfaces on screen and heals.
export const TASKS_SPEC = `Build a tiny Node.js HTTP server using only the built-in "http" module (no express or other npm packages) that serves a single-page interactive task list:

- GET / returns an HTML page (Content-Type: text/html) containing:
  - a heading "Tasks",
  - a text input with id="new-task" and a button with id="add",
  - an empty <ul id="list">.
  The page includes an inline <script> that, on load, fetches GET /api/tasks and renders one <li> per task into #list. Each <li> shows the task's title and contains a checkbox (input type="checkbox") that is checked when the task is done. A task that is done is shown with a line-through style on its title.
  Clicking the "add" button adds a new task whose title is the current text of #new-task to the bottom of the list (client-side only; it need not persist to the server), then clears the input. Toggling a task's checkbox flips whether its title is shown with a line-through.
- GET /api/tasks returns JSON (Content-Type: application/json): an array of about 4 seeded tasks, each shaped { id: number, title: string, done: boolean }, with at least one done and one not done.
- Anything else returns 404.
- Listen on process.env.PORT (or 3000) and log "Server ready" once listening.

Keep it to one index.js (you may inline the HTML and client script) plus a minimal package.json whose "start" script runs "node index.js".`;

// Tier 3 — DERIVED-STATE correctness. The hard part isn't rendering; it's
// keeping client-derived state consistent: a live "active" counter and a
// filtered view that must both stay correct when a task is toggled. Weak
// builders typically render fine but forget to update the counter or to
// re-apply the active filter after a toggle — bugs invisible to any server
// check and only catchable by driving the UI.
export const FILTER_SPEC = `Build a tiny Node.js HTTP server using only the built-in "http" module (no express or other npm packages) that serves a single-page "task filter" app:

- GET / returns an HTML page (Content-Type: text/html) containing:
  - a heading "Tasks",
  - three filter buttons with ids "filter-all", "filter-active", and "filter-done" ("All" is the active filter on load),
  - a status element with id "active-count" that shows how many tasks are NOT done (for example "3 active"),
  - a <ul id="list">.
  The page includes an inline <script> that, on load, fetches GET /api/tasks and renders one <li> per task into #list. Each <li> shows the task's title and a checkbox (input type="checkbox") that is checked when the task is done; a done task's title is shown with a line-through.
  - Clicking a filter button shows only the matching tasks — "filter-all" shows every task, "filter-active" shows only not-done tasks, "filter-done" shows only done tasks — and marks the clicked button as the active one (for example aria-pressed="true").
  - Toggling a task's checkbox flips its done state: it updates the title's line-through, updates the number in #active-count, and re-applies the current filter (so a task that no longer matches the active filter becomes hidden).
- GET /api/tasks returns JSON (Content-Type: application/json): an array of about 5 seeded tasks, each { id: number, title: string, done: boolean }, with a mix of done and not-done.
- Anything else returns 404.
- Listen on process.env.PORT (or 3000) and log "Server ready" once listening.

Keep it to one index.js (you may inline the HTML and client script) plus a minimal package.json whose "start" script runs "node index.js".`;

// Tier 4 — ASYNC / TIMING. A debounced live search with observable loading,
// results, no-results, and clear-restores states. Weak builders skip the
// loading state, fail to render the "no results" case (leaving stale or empty
// output), or don't restore all items when the query is cleared. The driver
// grades the settled end-state after each interaction (via waitFor), so it stays
// deterministic despite the async nature.
export const SEARCH_SPEC = `Build a tiny Node.js HTTP server using only the built-in "http" module (no express or other npm packages) that serves a single-page "live search" app:

- GET / returns an HTML page (Content-Type: text/html) containing:
  - a heading "Search",
  - a text input with id "search",
  - a status element with id "status",
  - a <ul id="results">.
  The page includes an inline <script> that queries GET /api/items?q=<query> as the user types (debounced by roughly 300ms) and renders the results into #results, one <li> per item showing its name. While a request is in flight #status shows "Searching…". When results arrive #status shows the count as "<n> results", or "No results" when there are none. On load (empty query) it shows all items with the matching count. Clearing the input returns to showing all items.
- GET /api/items?q=<query> returns JSON (Content-Type: application/json): an array of items { id: number, name: string } drawn from a seeded list of about 8 items whose name contains the query (case-insensitive); an empty or missing q returns all items.
- Anything else returns 404.
- Listen on process.env.PORT (or 3000) and log "Server ready" once listening.

Keep it to one index.js (you may inline the HTML and client script) plus a minimal package.json whose "start" script runs "node index.js".`;
