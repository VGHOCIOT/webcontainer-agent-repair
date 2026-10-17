import type { WebContainer } from "@webcontainer/api";
import type { CheckResult } from "./types";

// Interaction-level grading, entirely in the browser, with no backend.
//
// The loopback validator (validate.ts) fetches the served HTML/JSON over
// localhost — it can never click a button or read rendered DOM, so it can only
// grade the DATA layer. This module grades the FRONTEND: `setPreviewScript`
// injects a driver into every preview page, where it runs same-origin inside
// the iframe with full DOM access, performs scripted interactions (type, click,
// toggle), asserts on the resulting DOM, and `postMessage`s the same
// `{ checks: [...] }` contract back to us. A real browser driving the real UI,
// zero server, zero Selenium — the piece that lets a genuine frontend bug be
// detected, fed back, and healed on screen.
//
// The injected script is cross-origin (the preview tunnel), so we CANNOT reach
// into the iframe's DOM from here — all DOM work happens inside the injected
// harness and only serializable check results cross the postMessage boundary.

const DRIVER_MESSAGE_SOURCE = "agent-interaction-driver";
// Marks the grader's own hidden iframe. The identical driver is injected into
// the *visible* preview too, where this flag is absent so it stays passive —
// otherwise the driver would mutate the UI the user is watching.
const DRIVE_FLAG = "__agentDrive=1";

// Helpers + lifecycle wrapped around the per-spec driver body. The body is
// expected to define `async function runChecks()` returning CheckResult[]; it
// may use the helpers defined here ($ , $all, waitFor, setInput, click, struck).
// Written in ES5-ish style with no template literals so it embeds without
// escaping and runs in any preview page.
function buildHarness(driverBody: string): string {
  return `(function(){
  // Liveness beacon, sent BEFORE the passive-mode check so the parent can tell
  // "never injected / failed to parse" apart from "ran but flag missing" apart
  // from "ran, driving, never finished".
  try { window.parent.postMessage({ source: '${DRIVER_MESSAGE_SOURCE}', hello: true, hash: String(location.hash), href: String(location.href) }, '*'); } catch (e) {}
  if (String(location.hash).indexOf('${DRIVE_FLAG}') === -1) return; // passive in the visible preview
  var HARNESS_TIMEOUT = 12000;
  // The rendered DOM at post time — captured inside the iframe (the only place
  // with same-origin access) and shipped back so the parent can replay the
  // exact visual this attempt produced. On success that's the post-interaction
  // state (where a UI bug like a toggle that didn't restyle is visible); on
  // timeout/error it's whatever managed to render. Capped so a runaway page
  // can't flood postMessage.
  function capture(){ try { return String(document.documentElement.outerHTML).slice(0, 250000); } catch (e) { return ''; } }
  // Uncaught exceptions / unhandled rejections thrown by the page while it is
  // being driven. Listeners go up before the driver runs, so a throw in the
  // page's own script or in a handler the driver triggers is recorded. Reported
  // as one extra check on every post (including timeouts), so a "UI looks fine
  // but the console is throwing" app fails here without a separate probe.
  var CLIENT_ERRORS = [];
  window.addEventListener('error', function(ev){ CLIENT_ERRORS.push('uncaught exception: ' + String((ev && ev.message) || ev)); });
  window.addEventListener('unhandledrejection', function(ev){ var r = ev && ev.reason; CLIENT_ERRORS.push('unhandled promise rejection: ' + String((r && r.message) || r)); });
  function errorCheck(){
    return CLIENT_ERRORS.length === 0
      ? { name: 'frontend: no uncaught client errors', pass: true, details: 'No uncaught exception or unhandled rejection while the page loaded and was driven.' }
      : { name: 'frontend: no uncaught client errors', pass: false, details: CLIENT_ERRORS.slice(0, 5).join('; ') };
  }
  var POSTED = false;
  function post(checks){ if (POSTED) return; POSTED = true; try { window.parent.postMessage({ source: '${DRIVER_MESSAGE_SOURCE}', checks: checks.concat([errorCheck()]), snapshot: capture() }, '*'); } catch (e) {} }
  // Per-check isolation. The driver pushes each assertion through check(), so a
  // throw in ONE check (e.g. a missing element on a broken app) becomes a single
  // failing check with granular detail — not a total abort that loses every
  // other check's signal. RESULTS accumulates as checks run, so even a driver
  // that throws or hangs partway still reports what it got to.
  var RESULTS = [];
  async function check(name, fn){
    try { var d = await fn(); RESULTS.push({ name: name, pass: true, details: (d == null ? 'ok' : String(d)) }); }
    catch (e) { RESULTS.push({ name: name, pass: false, details: String((e && e.message) || e) }); }
  }
  function $(s){ return document.querySelector(s); }
  function $all(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  async function waitFor(pred, timeout){
    var t0 = Date.now();
    var limit = timeout || 4000;
    while (Date.now() - t0 < limit) {
      try { if (pred()) return true; } catch (e) {}
      await sleep(60);
    }
    return false;
  }
  function setInput(el, val){
    if (!el) return;
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function click(el){ if (el) el.click(); }
  function lineThrough(el){
    if (!el) return false;
    var cs = getComputedStyle(el);
    var d = (cs.textDecorationLine || cs.textDecoration || '') + '';
    return d.indexOf('line-through') !== -1;
  }
  // Line-through may sit on the <li> or any descendant (e.g. a <span>).
  function struck(el){
    if (!el) return false;
    if (lineThrough(el)) return true;
    var kids = el.querySelectorAll('*');
    for (var i = 0; i < kids.length; i++) { if (lineThrough(kids[i])) return true; }
    return false;
  }

  ${driverBody}

  function boot(){
    // On timeout, still ship whatever checks accumulated (plus a harness note),
    // so a driver that hangs partway doesn't erase the checks it did complete.
    var guard = setTimeout(function(){
      var out = RESULTS.slice();
      out.push({ name: 'interaction: harness', pass: false, details: 'driver did not finish within ' + HARNESS_TIMEOUT + 'ms' });
      post(out);
    }, HARNESS_TIMEOUT);
    Promise.resolve().then(function(){ return runChecks(); }).then(function(checks){
      clearTimeout(guard);
      // Accept either a returned array or checks pushed via check() into RESULTS.
      var out = (Array.isArray(checks) && checks.length) ? checks : RESULTS;
      if (out.length) post(out);
      else post([{ name: 'interaction: harness', pass: false, details: 'driver produced no checks' }]);
    }).catch(function(e){
      clearTimeout(guard);
      // Keep the granular checks collected before the throw; append the error.
      var out = RESULTS.slice();
      out.push({ name: 'interaction: harness', pass: false, details: 'driver threw after ' + RESULTS.length + ' checks: ' + String((e && e.message) || e) });
      post(out);
    });
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot);
})();`;
}

/**
 * Registers the per-spec interaction driver so it's injected into every preview
 * page load for the rest of the session. Persistent by design (setPreviewScript
 * applies to all subsequent previews), so call it once with the active driver.
 */
export async function registerInteractionDriver(
  webcontainer: WebContainer,
  driverBody: string,
): Promise<void> {
  const harness = buildHarness(driverBody);
  // Parse-only check (never executed): a syntax error in the model-authored body
  // would silently kill the whole injected script, surfacing only as a timeout.
  try {
    new Function(harness);
  } catch (err) {
    throw new Error(
      `Interaction driver has a syntax error and cannot run: ${(err as Error).message}. Regenerate the driver.`,
    );
  }
  // The argument is inline script SOURCE (WebContainer writes it to .preview-script.js
  // and evaluates it) — not a URL; a data: URL here is parsed as code and throws.
  await webcontainer.setPreviewScript(harness);
}

export interface DriveResult {
  checks: CheckResult[];
  // The rendered DOM the driver captured (outerHTML), for replay. "" if none.
  snapshot: string;
}

/**
 * Loads the running app in a hidden, loop-owned iframe flagged for driving, and
 * resolves with the checks the injected driver posts back plus a snapshot of the
 * rendered DOM for replay. Owning the iframe (rather than piggybacking on the
 * visible PreviewPane) gives clean correlation — we only accept the message from
 * THIS iframe — and works regardless of what the visible preview is doing. A
 * timeout becomes a single failing check so a page that never loads / never
 * reports feeds back like any other failure instead of hanging the loop.
 */
export function drivePreview(
  baseUrl: string,
  path: string,
  timeoutMs = 20_000,
): Promise<DriveResult> {
  return new Promise((resolve) => {
    // The flag rides in the URL HASH, never the query string: the hash is not sent
    // to the server, so a strict router (req.url === "/") still serves the page.
    // With a query string it 404s as plain text, nothing is injected, and the
    // harness never starts.
    const src = `${baseUrl}${path}#${DRIVE_FLAG}`;

    const iframe = document.createElement("iframe");
    // No `sandbox` attribute: the page is already a separate origin (the preview
    // tunnel), and allow-scripts + allow-same-origin gives no real isolation anyway.
    // A bare-iframe probe ran the preview script and reached us; the sandboxed
    // grader iframe never did, so the attribute is the prime suspect.
    // Rendered (so layout/getComputedStyle are real) but kept offscreen.
    Object.assign(iframe.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "1024px",
      height: "768px",
      opacity: "0",
      pointerEvents: "none",
      border: "0",
    });

    let settled = false;
    let loaded = false;
    let harnessStarted = false;
    let seenHash = "";
    function cleanup() {
      window.removeEventListener("message", onMessage);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
    function finish(result: DriveResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    }
    function onMessage(e: MessageEvent) {
      if (e.source !== iframe.contentWindow) return; // only OUR grader iframe
      const data = e.data as {
        source?: string;
        hello?: boolean;
        hash?: string;
        checks?: unknown;
        snapshot?: unknown;
      };
      if (!data || data.source !== DRIVER_MESSAGE_SOURCE) return;
      if (data.hello) {
        harnessStarted = true;
        seenHash = data.hash ?? "";
        return;
      }
      finish({
        checks: Array.isArray(data.checks)
          ? (data.checks as CheckResult[])
          : [{ name: "interaction: harness", pass: false, details: "driver sent no checks" }],
        snapshot: typeof data.snapshot === "string" ? data.snapshot : "",
      });
    }
    const timer = setTimeout(
      () =>
        finish({
          checks: [
            {
              name: "interaction: harness",
              pass: false,
              details: `no result from preview driver within ${timeoutMs}ms (iframe load event: ${loaded ? "fired" : "never fired"}; injected harness: ${harnessStarted ? `started (saw location.hash=${JSON.stringify(seenHash)}) but never reported` : "never started — not injected, or its script failed to parse"})`,
            },
          ],
          snapshot: "",
        }),
      timeoutMs,
    );

    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", () => {
      loaded = true;
    });
    iframe.src = src;
    document.body.appendChild(iframe);
  });
}
