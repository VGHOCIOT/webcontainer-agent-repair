import { DEFAULT_SPEC, FRONTEND_SPEC } from "./spec";
import { TASKS_SPEC, FILTER_SPEC, SEARCH_SPEC } from "./interactive";
import { appFiles, restFiles, swapLine, type NamedFiles } from "./fixtureKit";
import { GRADER_CORPUS } from "./graderCorpus";
import type { GeneratedFile } from "./types";

// Hand-written, known-good implementations of each preset spec, used ONLY to
// qualify graders (see qualify.ts): a freshly authored validator/driver must pass
// against the app the spec describes before its verdicts on a builder's output
// mean anything. A model-authored grader can be wrong (the pilot found an
// inverted counter assertion and a case-sensitive check against a
// case-insensitive spec); this catches that class — graders that are too strict
// or simply incorrect — before any batch is run.
//
// Keep each one a literal reading of its spec, nothing more. These are test
// fixtures for the grader, not examples for the builder, and they are never
// shown to the builder model.
//
// Client scripts avoid template literals and backticks so they embed here.

const REST_LINES = [
  'const http = require("http");',
  "const ITEMS = [];",
  'for (let i = 1; i <= 47; i++) ITEMS.push({ id: i, name: "Item " + i });',
  "function json(res, status, body) {",
  '  res.writeHead(status, { "Content-Type": "application/json" });',
  "  res.end(JSON.stringify(body));",
  "}",
  "function param(url, key, dflt) {",
  "  if (!url.searchParams.has(key)) return dflt;",
  "  const raw = url.searchParams.get(key);",
  "  if (!/^[0-9]+$/.test(raw)) return null;",
  "  const n = parseInt(raw, 10);",
  "  return n >= 1 ? n : null;",
  "}",
  "const server = http.createServer((req, res) => {",
  '  const url = new URL(req.url, "http://localhost");',
  '  if (req.method === "GET" && url.pathname === "/items") {',
  '    const page = param(url, "page", 1);',
  '    const limit = param(url, "limit", 10);',
  '    if (page === null) return json(res, 400, { error: "invalid page" });',
  '    if (limit === null) return json(res, 400, { error: "invalid limit" });',
  "    const start = (page - 1) * limit;",
  "    return json(res, 200, { page, limit, total: ITEMS.length, items: ITEMS.slice(start, start + limit) });",
  "  }",
  '  res.writeHead(404, { "Content-Type": "text/plain" });',
  '  res.end("Not found");',
  "});",
  "const PORT = process.env.PORT || 3000;",
  'server.listen(PORT, () => console.log("Server ready"));',
];

const TASKS_API = [
  '  if (req.method === "GET" && url.pathname === "/api/tasks") {',
  "    return json(res, 200, [",
  '      { id: 1, title: "Buy milk", done: true },',
  '      { id: 2, title: "Write report", done: false },',
  '      { id: 3, title: "Call dentist", done: false },',
  '      { id: 4, title: "Water plants", done: true },',
  '      { id: 5, title: "Book flights", done: false },',
  "    ]);",
  "  }",
].join("\n");

const FRONTEND_SCRIPT = [
    'fetch("/api/tasks").then(function (r) { return r.json(); }).then(function (tasks) {',
    '  var list = document.getElementById("list");',
    "  tasks.forEach(function (t) {",
    '    var li = document.createElement("li");',
    "    li.textContent = t.title;",
    '    if (t.done) li.style.textDecoration = "line-through";',
    "    list.appendChild(li);",
    "  });",
    "});",
];
const FRONTEND_BODY = '<h1>Tasks</h1><ul id="list"></ul>';

const TASKS_BODY =
  '<h1>Tasks</h1><input id="new-task" type="text"><button id="add">Add</button><ul id="list"></ul>';
const TASKS_SCRIPT = [
    "var tasks = [];",
    'var list = document.getElementById("list");',
    'var input = document.getElementById("new-task");',
    "function render() {",
    '  list.innerHTML = "";',
    "  tasks.forEach(function (t) {",
    '    var li = document.createElement("li");',
    '    var cb = document.createElement("input");',
    '    cb.type = "checkbox";',
    "    cb.checked = t.done;",
    '    var span = document.createElement("span");',
    "    span.textContent = t.title;",
    '    span.style.textDecoration = t.done ? "line-through" : "none";',
    '    cb.addEventListener("change", function () { t.done = cb.checked; render(); });',
    "    li.appendChild(cb);",
    "    li.appendChild(span);",
    "    list.appendChild(li);",
    "  });",
    "}",
    'document.getElementById("add").addEventListener("click", function () {',
    "  var title = input.value;",
    "  if (!title.trim()) return;",
    "  tasks.push({ id: Date.now(), title: title, done: false });",
    '  input.value = "";',
    "  render();",
    "});",
    'fetch("/api/tasks").then(function (r) { return r.json(); }).then(function (data) { tasks = data; render(); });',
];

const FILTER_BODY = [
    "<h1>Tasks</h1>",
    '<button id="filter-all">All</button>',
    '<button id="filter-active">Active</button>',
    '<button id="filter-done">Done</button>',
    '<p id="active-count"></p>',
    '<ul id="list"></ul>',
  ].join("");
const FILTER_SCRIPT = [
    "var tasks = [];",
    'var filter = "all";',
    'var list = document.getElementById("list");',
    'var buttons = { all: document.getElementById("filter-all"), active: document.getElementById("filter-active"), done: document.getElementById("filter-done") };',
    "function render() {",
    '  list.innerHTML = "";',
    "  tasks.forEach(function (t) {",
    '    if (filter === "active" && t.done) return;',
    '    if (filter === "done" && !t.done) return;',
    '    var li = document.createElement("li");',
    '    var cb = document.createElement("input");',
    '    cb.type = "checkbox";',
    "    cb.checked = t.done;",
    '    var span = document.createElement("span");',
    "    span.textContent = t.title;",
    '    span.style.textDecoration = t.done ? "line-through" : "none";',
    '    cb.addEventListener("change", function () { t.done = cb.checked; render(); });',
    "    li.appendChild(cb);",
    "    li.appendChild(span);",
    "    list.appendChild(li);",
    "  });",
    '  document.getElementById("active-count").textContent = tasks.filter(function (t) { return !t.done; }).length + " active";',
    "  Object.keys(buttons).forEach(function (k) { buttons[k].setAttribute(\"aria-pressed\", String(k === filter)); });",
    "}",
    "Object.keys(buttons).forEach(function (k) {",
    '  buttons[k].addEventListener("click", function () { filter = k; render(); });',
    "});",
    'fetch("/api/tasks").then(function (r) { return r.json(); }).then(function (data) { tasks = data; render(); });',
];

const SEARCH_API = [
  '  if (req.method === "GET" && url.pathname === "/api/items") {',
  '    const q = (url.searchParams.get("q") || "").toLowerCase();',
  "    const all = [",
  '      "Apple", "Banana", "Cherry", "Pineapple", "Grape", "Orange", "Blueberry", "Strawberry",',
  "    ].map(function (name, i) { return { id: i + 1, name: name }; });",
  "    return json(res, 200, all.filter(function (it) { return it.name.toLowerCase().indexOf(q) !== -1; }));",
  "  }",
].join("\n");

const SEARCH_BODY =
  '<h1>Search</h1><input id="search" type="text"><p id="status"></p><ul id="results"></ul>';
const SEARCH_SCRIPT = [
    'var input = document.getElementById("search");',
    'var statusEl = document.getElementById("status");',
    'var results = document.getElementById("results");',
    "var timer = null;",
    "var seq = 0;",
    "function run(q) {",
    "  var mine = ++seq;",
    '  statusEl.textContent = "Searching…";',
    '  fetch("/api/items?q=" + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (items) {',
    "    if (mine !== seq) return;",
    '    results.innerHTML = "";',
    "    items.forEach(function (it) {",
    '      var li = document.createElement("li");',
    "      li.textContent = it.name;",
    "      results.appendChild(li);",
    "    });",
    '    statusEl.textContent = items.length === 0 ? "No results" : items.length + " results";',
    "  });",
    "}",
    'input.addEventListener("input", function () {',
    "  clearTimeout(timer);",
    "  timer = setTimeout(function () { run(input.value); }, 300);",
    "});",
    'run("");',
];

const REFERENCES = new Map<string, GeneratedFile[]>([
  [DEFAULT_SPEC, restFiles(REST_LINES)],
  [FRONTEND_SPEC, appFiles(FRONTEND_BODY, FRONTEND_SCRIPT, TASKS_API)],
  [TASKS_SPEC, appFiles(TASKS_BODY, TASKS_SCRIPT, TASKS_API)],
  [FILTER_SPEC, appFiles(FILTER_BODY, FILTER_SCRIPT, TASKS_API)],
  [SEARCH_SPEC, appFiles(SEARCH_BODY, SEARCH_SCRIPT, SEARCH_API)],
]);

/** The known-good app for a preset spec, or null for a custom spec. */
export function referenceFor(spec: string): GeneratedFile[] | null {
  return REFERENCES.get(spec) ?? null;
}

// Known-BAD controls: the reference with exactly one spec requirement broken.
// Qualification requires every grader to FAIL each of these; a grader that passes
// one is too lenient to be trusted (it would wave through a builder's same bug).
// Each mutant violates a line the spec states outright — never an unspecified
// detail — so a correct grader has no excuse for missing it.
export type Mutant = NamedFiles;

const TOGGLE_HANDLER = 'cb.addEventListener("change", function () { t.done = cb.checked; render(); });';
const COUNT_LINE = 'document.getElementById("active-count").textContent';

const MUTANTS = new Map<string, Mutant[]>([
  [
    DEFAULT_SPEC,
    [
      {
        name: "page offset is off by one",
        files: restFiles(swapLine(REST_LINES, "const start = (page - 1) * limit;", "  const start = page * limit;")),
      },
      {
        name: "invalid page/limit accepted instead of a 400",
        files: restFiles(swapLine(REST_LINES, "if (!/^[0-9]+$/.test(raw)) return null;", "  if (!/^[0-9]+$/.test(raw)) return dflt;")),
      },
    ],
  ],
  [
    FRONTEND_SPEC,
    [
      {
        name: "done tasks are not struck through",
        files: appFiles(
          FRONTEND_BODY,
          swapLine(FRONTEND_SCRIPT, 'li.style.textDecoration = "line-through"', "    /* never struck */"),
          TASKS_API,
        ),
      },
    ],
  ],
  [
    TASKS_SPEC,
    [
      {
        name: "add does not clear the input",
        files: appFiles(TASKS_BODY, swapLine(TASKS_SCRIPT, 'input.value = "";', "  /* input left as is */"), TASKS_API),
      },
      {
        name: "toggle does not restyle the title",
        files: appFiles(
          TASKS_BODY,
          swapLine(TASKS_SCRIPT, TOGGLE_HANDLER, '    cb.addEventListener("change", function () { t.done = cb.checked; });'),
          TASKS_API,
        ),
      },
      {
        name: "added task is missing its title",
        files: appFiles(
          TASKS_BODY,
          swapLine(TASKS_SCRIPT, "tasks.push({ id: Date.now()", '  tasks.push({ id: Date.now(), title: "Untitled", done: false });'),
          TASKS_API,
        ),
      },
    ],
  ],
  [
    FILTER_SPEC,
    [
      {
        name: "active count not updated on toggle",
        files: appFiles(
          FILTER_BODY,
          swapLine(
            FILTER_SCRIPT,
            COUNT_LINE,
            '  if (window.__c === undefined) window.__c = tasks.filter(function (t) { return !t.done; }).length; document.getElementById("active-count").textContent = window.__c + " active";',
          ),
          TASKS_API,
        ),
      },
      {
        name: "filter not re-applied after toggle",
        files: appFiles(
          FILTER_BODY,
          swapLine(
            FILTER_SCRIPT,
            TOGGLE_HANDLER,
            '    cb.addEventListener("change", function () { t.done = cb.checked; span.style.textDecoration = t.done ? "line-through" : "none"; document.getElementById("active-count").textContent = tasks.filter(function (x) { return !x.done; }).length + " active"; });',
          ),
          TASKS_API,
        ),
      },
    ],
  ],
  [
    SEARCH_SPEC,
    [
      {
        name: "no 'No results' state",
        files: appFiles(
          SEARCH_BODY,
          swapLine(SEARCH_SCRIPT, '"No results"', '    statusEl.textContent = items.length + " results";'),
          SEARCH_API,
        ),
      },
      {
        name: "clearing the input does not restore the full list",
        files: appFiles(
          SEARCH_BODY,
          swapLine(SEARCH_SCRIPT, "timer = setTimeout(", "  timer = setTimeout(function () { if (input.value) run(input.value); }, 300);"),
          SEARCH_API,
        ),
      },
    ],
  ],
]);

/** Known-bad variants of a preset's reference app; empty for a custom spec. */
export function mutantsFor(spec: string): Mutant[] {
  return MUTANTS.get(spec) ?? [];
}

// Known-GOOD alternatives: other correct apps for the same spec built a different
// way (hidden vs removed from the DOM, ids vs none, different markup). The graders
// must PASS each, or they're overfit to the reference's structure and would fail a
// builder's equally correct app. Only the corpus specs have them.
const VARIANTS = new Map<string, NamedFiles[]>();

for (const entry of GRADER_CORPUS) {
  REFERENCES.set(entry.spec, entry.reference);
  MUTANTS.set(entry.spec, entry.mutants);
  VARIANTS.set(entry.spec, entry.variants);
}

/** Known-good, differently built apps for a spec; empty when it has none. */
export function variantsFor(spec: string): NamedFiles[] {
  return VARIANTS.get(spec) ?? [];
}
