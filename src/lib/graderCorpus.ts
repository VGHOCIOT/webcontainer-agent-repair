import { appFiles, swapLine, type NamedFiles } from "./fixtureKit";
import type { GeneratedFile } from "./types";

// Grader-robustness corpus. Each entry is a loosely worded, realistic custom spec
// (no element ids — the way a user would actually write one) plus three kinds of
// hand-written fixtures:
//   - reference: a literal, known-good reading of the spec;
//   - variants:  other known-GOOD apps that satisfy the same spec with a different
//                DOM strategy (hidden vs removed, ids vs none, different markup).
//                A grader that fails one is overfit to the reference's structure —
//                exactly what a builder's differently-built correct app would hit;
//   - mutants:   the reference with one stated requirement broken; graders must fail each.
// Run by the "Grader eval" panel to measure how often freshly authored graders
// qualify, so grader-authoring prompt changes can be compared. The entries are also
// registered as qualification references (referenceApps.ts), so a batch on one of
// these specs is gated like any preset. Fixtures only — never shown to the builder.

export interface CorpusEntry {
  name: string;
  spec: string;
  reference: GeneratedFile[];
  variants: NamedFiles[];
  mutants: NamedFiles[];
}

const SERVER_TAIL = `- Listen on process.env.PORT (or 3000) and log "Server ready" once listening. Keep it to one index.js plus a minimal package.json whose "start" script runs "node index.js".`;
const NODE_HEAD = `Build a small Node.js web app (built-in "http" module only, no npm packages)`;

const HEALTH = '  if (url.pathname === "/api/health") return json(res, 200, { ok: true });';

// ---------------------------------------------------------------- Flashcards

const FLASHCARDS_SPEC = `${NODE_HEAD} that is a flashcard quiz.

- GET / serves a single HTML page with a heading "Flashcards", a card area showing the current question, a "Show answer" button, a "Next" button, and a progress line like "Card 1 of 3".
- On load the page fetches GET /api/cards and shows the first card's question. Clicking "Show answer" reveals that card's answer below the question. Clicking "Next" moves to the next card, hides its answer again, and updates the progress line; after the last card it wraps back to the first.
- GET /api/cards returns JSON: an array of exactly 3 cards, each { id: number, question: string, answer: string }.
${SERVER_TAIL}`;

const CARDS_API = [
  '  if (req.method === "GET" && url.pathname === "/api/cards") {',
  "    return json(res, 200, [",
  '      { id: 1, question: "What is the capital of France?", answer: "Paris" },',
  '      { id: 2, question: "What is 2 + 2?", answer: "4" },',
  '      { id: 3, question: "Largest planet in the solar system?", answer: "Jupiter" },',
  "    ]);",
  "  }",
].join("\n");

const FLASH_BODY =
  '<h1>Flashcards</h1><div id="progress"></div><div id="question"></div><div id="answer" style="display:none"></div><button id="show">Show answer</button> <button id="next">Next</button>';
const FLASH_SCRIPT = [
  "var cards = [], i = 0, shown = false;",
  'var q = document.getElementById("question"), a = document.getElementById("answer"), pr = document.getElementById("progress");',
  "function render() {",
  "  if (!cards.length) return;",
  "  q.textContent = cards[i].question;",
  "  a.textContent = cards[i].answer;",
  '  a.style.display = shown ? "block" : "none";',
  '  pr.textContent = "Card " + (i + 1) + " of " + cards.length;',
  "}",
  'fetch("/api/cards").then(function (r) { return r.json(); }).then(function (c) { cards = c; render(); });',
  'document.getElementById("show").addEventListener("click", function () { shown = true; render(); });',
  'document.getElementById("next").addEventListener("click", function () {',
  "  i = (i + 1) % cards.length;",
  "  shown = false;",
  "  render();",
  "});",
];
// Valid variant: no ids, the answer is ABSENT from the DOM until revealed (not
// display:none), progress sits in a <span>.
const FLASH_VARIANT_BODY =
  '<h1>Flashcards</h1><section class="card"><p class="q"></p></section><p>Progress: <span class="pos"></span></p><button type="button">Show answer</button> <button type="button">Next</button>';
const FLASH_VARIANT_SCRIPT = [
  "var cards = [], i = 0, shown = false;",
  'var box = document.querySelector(".card"), q = document.querySelector(".q"), pos = document.querySelector(".pos");',
  'var btns = document.querySelectorAll("button");',
  "function render() {",
  "  if (!cards.length) return;",
  "  q.textContent = cards[i].question;",
  '  var old = box.querySelector(".ans");',
  "  if (old) box.removeChild(old);",
  "  if (shown) {",
  '    var p = document.createElement("p");',
  '    p.className = "ans";',
  "    p.textContent = cards[i].answer;",
  "    box.appendChild(p);",
  "  }",
  '  pos.textContent = "Card " + (i + 1) + " of " + cards.length;',
  "}",
  'fetch("/api/cards").then(function (r) { return r.json(); }).then(function (c) { cards = c; render(); });',
  'btns[0].addEventListener("click", function () { shown = true; render(); });',
  'btns[1].addEventListener("click", function () { i = (i + 1) % cards.length; shown = false; render(); });',
];

// ---------------------------------------------------------------- Tip splitter

const TIP_SPEC = `${NODE_HEAD} that is a tip splitter.

- GET / serves a single HTML page with a heading "Tip Splitter", a number input for the bill total, a number input for the tip percentage (default 15), a number input for the number of people (default 2), and a Calculate button.
- Clicking Calculate shows the tip amount, the total with tip, and the amount each person pays, all formatted to two decimal places, in elements on the page. If the bill is empty or the number of people is less than 1, show an error message instead of results.
- GET /api/health returns JSON { "ok": true }.
${SERVER_TAIL}`;

const TIP_BODY =
  '<h1>Tip Splitter</h1><label>Bill <input id="bill" type="number"></label> <label>Tip % <input id="tip" type="number" value="15"></label> <label>People <input id="people" type="number" value="2"></label> <button id="calc">Calculate</button><p id="error" style="color:red"></p><div id="results" style="display:none"><p>Tip: <span id="tip-amount"></span></p><p>Total: <span id="total"></span></p><p>Each pays: <span id="per-person"></span></p></div>';
const TIP_SCRIPT = [
  'var billEl = document.getElementById("bill"), tipEl = document.getElementById("tip"), peopleEl = document.getElementById("people");',
  'var err = document.getElementById("error"), results = document.getElementById("results");',
  'document.getElementById("calc").addEventListener("click", function () {',
  "  var bill = parseFloat(billEl.value), n = parseInt(peopleEl.value, 10), pct = parseFloat(tipEl.value);",
  "  if (isNaN(bill) || !(n >= 1)) {",
  '    err.textContent = "Please enter a bill amount and at least 1 person.";',
  '    results.style.display = "none";',
  "    return;",
  "  }",
  '  err.textContent = "";',
  "  var tip = bill * (isNaN(pct) ? 0 : pct) / 100, total = bill + tip, per = total / n;",
  '  document.getElementById("tip-amount").textContent = tip.toFixed(2);',
  '  document.getElementById("total").textContent = total.toFixed(2);',
  '  document.getElementById("per-person").textContent = per.toFixed(2);',
  '  results.style.display = "block";',
  "});",
];
// Valid variant: no ids; inputs found by order; results and error are created and
// removed (not toggled) inside one output region.
const TIP_VARIANT_BODY =
  '<h1>Tip Splitter</h1><form onsubmit="return false"><div><span>Bill total</span><input type="number" step="any"></div><div><span>Tip percentage</span><input type="number" value="15"></div><div><span>Number of people</span><input type="number" value="2"></div><button type="button">Calculate</button></form><div class="out"></div>';
const TIP_VARIANT_SCRIPT = [
  'var ins = document.querySelectorAll("input"), out = document.querySelector(".out");',
  'document.querySelector("button").addEventListener("click", function () {',
  "  var bill = parseFloat(ins[0].value), pct = parseFloat(ins[1].value), n = parseInt(ins[2].value, 10);",
  '  out.innerHTML = "";',
  "  if (isNaN(bill) || !(n >= 1)) {",
  '    out.innerHTML = "<p class=\\"error\\">Enter a bill and at least one person.</p>";',
  "    return;",
  "  }",
  "  var tip = bill * pct / 100, total = bill + tip;",
  '  out.innerHTML = "<p>Tip amount: " + tip.toFixed(2) + "</p><p>Total with tip: " + total.toFixed(2) + "</p><p>Per person: " + (total / n).toFixed(2) + "</p>";',
  "});",
];

// ---------------------------------------------------------------- Counter

const COUNTER_SPEC = `${NODE_HEAD} that is a simple counter.

- GET / serves a single HTML page with a heading "Counter", the current value shown large (starting at 0), a "+" button, a "-" button, and a "Reset" button.
- "+" adds 1 and "-" subtracts 1. The value never goes below 0. "Reset" sets it back to 0.
- GET /api/health returns JSON { "ok": true }.
${SERVER_TAIL}`;

const COUNTER_BODY =
  '<h1>Counter</h1><div id="value" style="font-size:48px">0</div><button id="inc">+</button> <button id="dec">-</button> <button id="reset">Reset</button>';
const COUNTER_SCRIPT = [
  "var n = 0;",
  'var v = document.getElementById("value");',
  'function show() { v.textContent = String(n); }',
  'document.getElementById("inc").addEventListener("click", function () { n += 1; show(); });',
  'document.getElementById("dec").addEventListener("click", function () { n = Math.max(0, n - 1); show(); });',
  'document.getElementById("reset").addEventListener("click", function () { n = 0; show(); });',
];
// Valid variant: value in an <output>, buttons found only by text, state kept in the DOM.
const COUNTER_VARIANT_BODY =
  '<h1>Counter</h1><p>Value: <output style="font-size:3em">0</output></p><div><button>+</button><button>-</button><button>Reset</button></div>';
const COUNTER_VARIANT_SCRIPT = [
  'var out = document.querySelector("output");',
  'document.querySelectorAll("button").forEach(function (b) {',
  '  b.addEventListener("click", function () {',
  "    var cur = parseInt(out.textContent, 10);",
  '    if (b.textContent === "+") cur += 1;',
  '    else if (b.textContent === "-") cur = cur > 0 ? cur - 1 : 0;',
  "    else cur = 0;",
  "    out.textContent = cur;",
  "  });",
  "});",
];

// ---------------------------------------------------------------- Accordion FAQ

const FAQ_SPEC = `${NODE_HEAD} that is an FAQ accordion.

- GET / serves a single HTML page with a heading "FAQ" and a list of questions loaded from GET /api/faq. Each question is a clickable header; its answer is hidden until the question is clicked.
- Clicking a question shows its answer and hides any other open answer, so at most one answer is open at a time. Clicking the open question again hides its answer. All answers are hidden on load.
- GET /api/faq returns JSON: an array of exactly 3 items, each { id: number, question: string, answer: string }.
${SERVER_TAIL}`;

const FAQ_API = [
  '  if (req.method === "GET" && url.pathname === "/api/faq") {',
  "    return json(res, 200, [",
  '      { id: 1, question: "How do I reset my password?", answer: "Use the Forgot password link on the sign-in page." },',
  '      { id: 2, question: "Can I change my plan?", answer: "Yes, upgrade or downgrade any time from Billing." },',
  '      { id: 3, question: "Where is my invoice?", answer: "Invoices are emailed monthly and listed under Billing." },',
  "    ]);",
  "  }",
].join("\n");

const FAQ_BODY = '<h1>FAQ</h1><div id="faq"></div>';
const FAQ_SCRIPT = [
  "var items = [], open = -1;",
  'var root = document.getElementById("faq");',
  "function render() {",
  '  root.innerHTML = "";',
  "  items.forEach(function (it, idx) {",
  '    var h = document.createElement("button");',
  '    h.className = "q";',
  "    h.textContent = it.question;",
  '    h.addEventListener("click", function () { open = open === idx ? -1 : idx; render(); });',
  '    var p = document.createElement("div");',
  '    p.className = "a";',
  "    p.textContent = it.answer;",
  '    p.style.display = open === idx ? "block" : "none";',
  "    root.appendChild(h);",
  "    root.appendChild(p);",
  "  });",
  "}",
  'fetch("/api/faq").then(function (r) { return r.json(); }).then(function (d) { items = d; render(); });',
];
// Valid variant: answers exist in the DOM only while open (removed, not hidden); the
// open state lives on the items, and headers are <h3 role="button">, not <button>.
const FAQ_VARIANT_SCRIPT = [
  "var items = [];",
  'var root = document.getElementById("faq");',
  "function render() {",
  '  root.innerHTML = "";',
  "  items.forEach(function (it) {",
  '    var h = document.createElement("h3");',
  '    h.setAttribute("role", "button");',
  '    h.style.cursor = "pointer";',
  "    h.textContent = it.question;",
  '    h.addEventListener("click", function () {',
  "      var was = it.isOpen;",
  "      items.forEach(function (o) { o.isOpen = false; });",
  "      it.isOpen = !was;",
  "      render();",
  "    });",
  "    root.appendChild(h);",
  "    if (it.isOpen) {",
  '      var p = document.createElement("p");',
  "      p.textContent = it.answer;",
  "      root.appendChild(p);",
  "    }",
  "  });",
  "}",
  'fetch("/api/faq").then(function (r) { return r.json(); }).then(function (d) { items = d; render(); });',
];

// ---------------------------------------------------------------- Star rating

const RATING_SPEC = `${NODE_HEAD} that is a star rating widget.

- GET / serves a single HTML page with a heading "Rate this", five stars in a row, and a line of text showing the current rating.
- Empty stars are shown as ☆ and filled stars as ★. Clicking star number N fills stars 1 through N and empties the rest, and the text line reads "Rating: N of 5". Before anything is clicked, all stars are empty and the line reads "Rating: none yet".
- Clicking the star that is already the current rating clears the rating (all empty, "Rating: none yet").
- GET /api/health returns JSON { "ok": true }.
${SERVER_TAIL}`;

const RATING_BODY = '<h1>Rate this</h1><div id="stars"></div><p id="label">Rating: none yet</p>';
const RATING_SCRIPT = [
  "var rating = 0;",
  'var box = document.getElementById("stars"), label = document.getElementById("label");',
  "function render() {",
  '  box.innerHTML = "";',
  "  for (var s = 1; s <= 5; s++) {",
  "    (function (n) {",
  '      var b = document.createElement("button");',
  '      b.textContent = n <= rating ? "\\u2605" : "\\u2606";',
  '      b.addEventListener("click", function () { rating = rating === n ? 0 : n; render(); });',
  "      box.appendChild(b);",
  "    })(s);",
  "  }",
  '  label.textContent = rating ? "Rating: " + rating + " of 5" : "Rating: none yet";',
  "}",
  "render();",
];
// Valid variant: stars are <span role="button"> inside a list, text line is a <strong>.
const RATING_VARIANT_BODY = '<h1>Rate this</h1><ul class="row" style="list-style:none;display:flex;padding:0"></ul><p><strong>Rating: none yet</strong></p>';
const RATING_VARIANT_SCRIPT = [
  "var cur = 0;",
  'var row = document.querySelector(".row"), line = document.querySelector("strong");',
  "function draw() {",
  '  row.innerHTML = "";',
  "  for (var k = 1; k <= 5; k++) {",
  "    (function (n) {",
  '      var li = document.createElement("li");',
  '      var sp = document.createElement("span");',
  '      sp.setAttribute("role", "button");',
  '      sp.style.cursor = "pointer";',
  '      sp.textContent = cur >= n ? "\\u2605" : "\\u2606";',
  '      sp.onclick = function () { cur = cur === n ? 0 : n; draw(); };',
  "      li.appendChild(sp);",
  "      row.appendChild(li);",
  "    })(k);",
  "  }",
  '  line.textContent = cur === 0 ? "Rating: none yet" : "Rating: " + cur + " of 5";',
  "}",
  "draw();",
];

// ---------------------------------------------------------------- Tabs

const TABS_SPEC = `${NODE_HEAD} that is a tabbed panel.

- GET / serves a single HTML page with a heading "Product" and three tabs labelled "Overview", "Details" and "Reviews". Each tab has its own content panel, with the text "Overview content", "Details content" and "Reviews content" respectively.
- Only the selected tab's panel is visible. "Overview" is selected on load. Clicking a tab selects it and shows only its panel.
- The selected tab has aria-selected="true" and the other tabs have aria-selected="false".
- GET /api/health returns JSON { "ok": true }.
${SERVER_TAIL}`;

const TABS_BODY =
  '<h1>Product</h1><div role="tablist"><button role="tab" id="t0" aria-selected="true">Overview</button><button role="tab" id="t1" aria-selected="false">Details</button><button role="tab" id="t2" aria-selected="false">Reviews</button></div><div class="panel">Overview content</div><div class="panel" style="display:none">Details content</div><div class="panel" style="display:none">Reviews content</div>';
const TABS_SCRIPT = [
  'var tabs = document.querySelectorAll("[role=tab]"), panels = document.querySelectorAll(".panel");',
  "function select(k) {",
  "  tabs.forEach(function (t, j) {",
  '    t.setAttribute("aria-selected", j === k ? "true" : "false");',
  '    panels[j].style.display = j === k ? "block" : "none";',
  "  });",
  "}",
  "tabs.forEach(function (t, j) { t.addEventListener(\"click\", function () { select(j); }); });",
];
// Valid variant: anchor tabs, all three panels present in the markup and hidden with
// the `hidden` attribute (the reference hides with inline display:none instead).
const TABS_VARIANT_BODY =
  '<h1>Product</h1><nav><a href="#" role="tab" aria-selected="true">Overview</a> <a href="#" role="tab" aria-selected="false">Details</a> <a href="#" role="tab" aria-selected="false">Reviews</a></nav><section><p>Overview content</p><p hidden>Details content</p><p hidden>Reviews content</p></section>';
const TABS_VARIANT_SCRIPT = [
  'var tabs = document.querySelectorAll("[role=tab]"), panels = document.querySelectorAll("section p");',
  "function select(k) {",
  '  tabs.forEach(function (t, j) { t.setAttribute("aria-selected", j === k ? "true" : "false"); });',
  "  panels.forEach(function (p, j) { p.hidden = j !== k; });",
  "}",
  'tabs.forEach(function (t, j) { t.addEventListener("click", function (e) { e.preventDefault(); select(j); }); });',
];

// ---------------------------------------------------------------- Registry

const cardsApp = (body: string, script: string[]) => appFiles(body, script, CARDS_API);
const healthApp = (body: string, script: string[]) => appFiles(body, script, HEALTH);
const faqApp = (body: string, script: string[]) => appFiles(body, script, FAQ_API);

export const GRADER_CORPUS: CorpusEntry[] = [
  {
    name: "Flashcards",
    spec: FLASHCARDS_SPEC,
    reference: cardsApp(FLASH_BODY, FLASH_SCRIPT),
    variants: [{ name: "answer absent from the DOM until revealed, no ids", files: cardsApp(FLASH_VARIANT_BODY, FLASH_VARIANT_SCRIPT) }],
    mutants: [
      {
        name: "answer visible before Show answer is clicked",
        files: cardsApp(FLASH_BODY, swapLine(FLASH_SCRIPT, 'a.style.display = shown ? "block" : "none";', '  a.style.display = "block";')),
      },
      {
        name: "Next does not wrap after the last card",
        files: cardsApp(FLASH_BODY, swapLine(FLASH_SCRIPT, "i = (i + 1) % cards.length;", "  if (i < cards.length - 1) i++;")),
      },
      {
        name: "Next keeps the answer revealed",
        files: cardsApp(FLASH_BODY, swapLine(FLASH_SCRIPT, "  shown = false;", "  /* answer stays revealed */")),
      },
    ],
  },
  {
    name: "Tip splitter",
    spec: TIP_SPEC,
    reference: healthApp(TIP_BODY, TIP_SCRIPT),
    variants: [{ name: "no ids, inputs by order, results rebuilt per click", files: healthApp(TIP_VARIANT_BODY, TIP_VARIANT_SCRIPT) }],
    mutants: [
      {
        name: "per-person amount is not divided by the number of people",
        files: healthApp(TIP_BODY, swapLine(TIP_SCRIPT, "var tip = bill * (isNaN(pct)", "  var tip = bill * (isNaN(pct) ? 0 : pct) / 100, total = bill + tip, per = total;")),
      },
      {
        name: "empty bill shows results instead of an error",
        files: healthApp(TIP_BODY, swapLine(TIP_SCRIPT, "if (isNaN(bill) || !(n >= 1)) {", "  if (!(n >= 1)) {")),
      },
    ],
  },
  {
    name: "Counter",
    spec: COUNTER_SPEC,
    reference: healthApp(COUNTER_BODY, COUNTER_SCRIPT),
    variants: [{ name: "<output> value, buttons found by text only", files: healthApp(COUNTER_VARIANT_BODY, COUNTER_VARIANT_SCRIPT) }],
    mutants: [
      {
        name: "value can go below zero",
        files: healthApp(COUNTER_BODY, swapLine(COUNTER_SCRIPT, "n = Math.max(0, n - 1);", 'document.getElementById("dec").addEventListener("click", function () { n -= 1; show(); });')),
      },
      {
        name: "Reset does not return to 0",
        files: healthApp(COUNTER_BODY, swapLine(COUNTER_SCRIPT, '"reset").addEventListener', '  document.getElementById("reset").addEventListener("click", function () { show(); });')),
      },
    ],
  },
  {
    name: "FAQ accordion",
    spec: FAQ_SPEC,
    reference: faqApp(FAQ_BODY, FAQ_SCRIPT),
    variants: [{ name: "answers removed from the DOM while closed, role=button headers", files: faqApp(FAQ_BODY, FAQ_VARIANT_SCRIPT) }],
    mutants: [
      {
        name: "opening one question does not close the others",
        files: faqApp(FAQ_BODY, swapLine(FAQ_SCRIPT, "open = open === idx ? -1 : idx; render();", '    h.addEventListener("click", function () { p.style.display = "block"; });')),
      },
      {
        name: "clicking an open question does not collapse it",
        files: faqApp(FAQ_BODY, swapLine(FAQ_SCRIPT, "open = open === idx ? -1 : idx; render();", '    h.addEventListener("click", function () { open = idx; render(); });')),
      },
    ],
  },
  {
    name: "Star rating",
    spec: RATING_SPEC,
    reference: healthApp(RATING_BODY, RATING_SCRIPT),
    variants: [{ name: "span role=button stars in a list", files: healthApp(RATING_VARIANT_BODY, RATING_VARIANT_SCRIPT) }],
    mutants: [
      {
        name: "clicking the current rating does not clear it",
        files: healthApp(RATING_BODY, swapLine(RATING_SCRIPT, "rating = rating === n ? 0 : n;", '      b.addEventListener("click", function () { rating = n; render(); });')),
      },
      {
        name: "star N fills only star N instead of 1 through N",
        files: healthApp(RATING_BODY, swapLine(RATING_SCRIPT, 'b.textContent = n <= rating', '      b.textContent = n === rating ? "\\u2605" : "\\u2606";')),
      },
    ],
  },
  {
    name: "Tabs",
    spec: TABS_SPEC,
    reference: healthApp(TABS_BODY, TABS_SCRIPT),
    variants: [{ name: "anchor tabs, panels hidden with the hidden attribute", files: healthApp(TABS_VARIANT_BODY, TABS_VARIANT_SCRIPT) }],
    mutants: [
      {
        name: "all panels stay visible",
        files: healthApp(TABS_BODY, swapLine(TABS_SCRIPT, 'panels[j].style.display = j === k ? "block" : "none";', '    panels[j].style.display = "block";')),
      },
      {
        name: "aria-selected is not updated on click",
        files: healthApp(TABS_BODY, swapLine(TABS_SCRIPT, 't.setAttribute("aria-selected", j === k ? "true" : "false");', "    /* aria-selected left as is */")),
      },
    ],
  },
];
