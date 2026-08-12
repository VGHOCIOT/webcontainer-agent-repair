import type { WebContainer } from "@webcontainer/api";
import type { CheckResult, ValidationResult } from "./types";

const VALIDATE_SCRIPT_PATH = ".agent-validate.mjs";

// Runs the validator as a Node script INSIDE the container, hitting
// http://localhost:<port> directly. This deliberately avoids the browser:
// fetching the public WebContainer preview URL from page JS goes through an
// external CloudFront tunnel that (empirically) only reliably routes real
// navigations (e.g. the preview pane's <iframe src>), not same-page fetch()
// calls — so validating that way produced a persistent, unfixable-by-the-
// generated-code "failed to fetch". From inside the container it's just a
// normal loopback HTTP request.
//
// The script itself is generated per-spec (see validatorGen.ts / Mode A) and
// must print, as its last stdout line, { checks: [{ name, pass, details }] }.

function isCheckResult(c: unknown): c is CheckResult {
  return (
    typeof c === "object" &&
    c !== null &&
    typeof (c as CheckResult).name === "string" &&
    typeof (c as CheckResult).pass === "boolean" &&
    typeof (c as CheckResult).details === "string"
  );
}

/**
 * Writes `script` into the container and runs it as a Node process with `args`,
 * returning the parsed per-check results from its last stdout line (the shared
 * `{ checks: [...] }` contract). `checks` is null when the output didn't parse —
 * the caller decides how to treat that. Shared by the generated validator and
 * the static fuzz probe so both honor the identical contract.
 */
export async function runCheckScript(
  webcontainer: WebContainer,
  scriptPath: string,
  script: string,
  args: string[],
): Promise<{ checks: CheckResult[] | null; output: string; exitCode: number }> {
  await webcontainer.fs.writeFile(scriptPath, script);

  const process = await webcontainer.spawn("node", [scriptPath, ...args]);

  let output = "";
  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        output += chunk;
      },
    }),
  );

  const exitCode = await process.exit;
  const lastLine = output.trim().split("\n").pop() ?? "";

  try {
    const result = JSON.parse(lastLine);
    if (Array.isArray(result.checks) && result.checks.every(isCheckResult)) {
      return { checks: result.checks, output, exitCode };
    }
  } catch {
    // fall through
  }
  return { checks: null, output, exitCode };
}

export function aggregateChecks(checks: CheckResult[]): ValidationResult {
  const pass = checks.length > 0 && checks.every((c) => c.pass);
  const failing = checks.filter((c) => !c.pass);
  const details = pass
    ? `All ${checks.length} checks passed.`
    : failing.map((c) => `✗ ${c.name}: ${c.details}`).join("\n");
  return { pass, details, checks };
}

/**
 * Runs the generated validator against the running app and returns per-check
 * results. Doubles as the "did it actually work" signal the agent loop retries
 * against — a running server that fails these checks is treated the same as a
 * crash. Unparseable validator output is itself a failure (no checks), which
 * keeps a broken validator from silently passing the build.
 */
export async function validateApp(
  webcontainer: WebContainer,
  port: number,
  script: string,
): Promise<ValidationResult> {
  const { checks, output, exitCode } = await runCheckScript(
    webcontainer,
    VALIDATE_SCRIPT_PATH,
    script,
    [String(port)],
  );

  if (checks) return aggregateChecks(checks);

  return {
    pass: false,
    details: `Validator produced no parseable { checks: [...] } result (exit code ${exitCode}). Raw output:\n${output}`,
    checks: [],
  };
}
