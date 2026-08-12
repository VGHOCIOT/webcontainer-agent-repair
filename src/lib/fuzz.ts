import type { WebContainer } from "@webcontainer/api";
import type { CheckResult } from "./types";
import { runCheckScript } from "./validate";

const FUZZ_SCRIPT_PATH = ".agent-fuzz.mjs";

// A STATIC (non-AI) black-box probe run inside the container against the live
// server, honoring the same `{ checks: [...] }` contract as the generated
// validator. It's a disclosed environment perturbation, exactly like the PORT
// and offline-install probes: the well-formed validator says the app is
// correct; this asks whether it also survives concurrency and hostile input —
// bug classes (unhandled input → 500, crash under load) a single happy-path
// request never surfaces. Uses only built-ins (global fetch), no template
// literals, so it embeds here without escaping.
const FUZZ_SCRIPT = `
const port = process.argv[2];
const path = process.argv[3] || '/';
const base = 'http://localhost:' + port;
const target = base + path;
const sep = target.indexOf('?') === -1 ? '?' : '&';

async function safeFetch(url, opts) {
  try {
    const res = await fetch(url, opts);
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

async function run() {
  const checks = [];

  // 1. Concurrency: fire a burst of parallel requests at the same endpoint.
  const N = 25;
  const burst = await Promise.all(
    Array.from({ length: N }, function () { return safeFetch(target); })
  );
  const dropped = burst.filter(function (r) { return !r.ok; });
  const load5xx = burst.filter(function (r) { return r.ok && r.status >= 500; });
  checks.push({
    name: 'fuzz: handles concurrent load',
    pass: dropped.length === 0 && load5xx.length === 0,
    details:
      dropped.length === 0 && load5xx.length === 0
        ? N + ' concurrent requests all returned < 500'
        : dropped.length + ' connection drops, ' + load5xx.length + ' returned 5xx (of ' + N + ')',
  });

  // 2. Malformed input: none of these should produce a 5xx or drop the socket.
  const probes = [
    { label: 'garbage query string', url: target + sep + 'x=%ZZ&n=-1&n=abc&limit=99999999999' },
    { label: 'oversized query param', url: target + sep + 'q=' + 'A'.repeat(20000) },
    { label: 'junk JSON body POST', url: target, opts: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json,,' } },
    { label: 'unexpected method', url: target, opts: { method: 'DELETE' } },
  ];
  const probeResults = [];
  for (const p of probes) {
    const r = await safeFetch(p.url, p.opts);
    probeResults.push({ label: p.label, ok: r.ok, status: r.status });
  }
  const crashed = probeResults.filter(function (r) { return !r.ok; });
  const errored = probeResults.filter(function (r) { return r.ok && r.status >= 500; });
  checks.push({
    name: 'fuzz: no 5xx on malformed input',
    pass: crashed.length === 0 && errored.length === 0,
    details:
      crashed.length === 0 && errored.length === 0
        ? 'all ' + probes.length + ' malformed requests handled without a server error'
        : crashed.map(function (r) { return r.label + ' (socket dropped)'; })
            .concat(errored.map(function (r) { return r.label + ' (HTTP ' + r.status + ')'; }))
            .join('; '),
  });

  // 3. Stability: the server must still answer normally after the barrage.
  const after = await safeFetch(target);
  checks.push({
    name: 'fuzz: server still responsive afterward',
    pass: after.ok && after.status < 500,
    details: after.ok
      ? 'server responded HTTP ' + after.status + ' after the fuzzing barrage'
      : 'server unreachable after fuzzing: ' + (after.error || 'connection failed'),
  });

  console.log(JSON.stringify({ checks: checks }));
}

run().catch(function (e) {
  console.log(JSON.stringify({ checks: [{ name: 'fuzz: harness', pass: false, details: 'fuzz probe crashed: ' + String((e && e.message) || e) }] }));
});
`;

/**
 * Runs the static fuzz probe against the running app and returns its per-check
 * results, to be merged into the attempt's validation so failures feed back
 * through the normal retry path (and show up in the healing timeline as their
 * own checks). Unparseable output becomes a single failing check rather than
 * silently passing.
 */
export async function runFuzz(
  webcontainer: WebContainer,
  port: number,
  path: string,
): Promise<CheckResult[]> {
  const { checks, exitCode, output } = await runCheckScript(
    webcontainer,
    FUZZ_SCRIPT_PATH,
    FUZZ_SCRIPT,
    [String(port), path],
  );
  if (checks) return checks;
  return [
    {
      name: "fuzz: harness",
      pass: false,
      details: `fuzz probe produced no parseable result (exit ${exitCode}): ${output.slice(0, 300)}`,
    },
  ];
}
