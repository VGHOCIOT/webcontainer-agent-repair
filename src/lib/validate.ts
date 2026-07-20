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

function aggregate(checks: CheckResult[]): ValidationResult {
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
  await webcontainer.fs.writeFile(VALIDATE_SCRIPT_PATH, script);

  const process = await webcontainer.spawn("node", [
    VALIDATE_SCRIPT_PATH,
    String(port),
  ]);

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
    if (
      Array.isArray(result.checks) &&
      result.checks.every(
        (c: unknown): c is CheckResult =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as CheckResult).name === "string" &&
          typeof (c as CheckResult).pass === "boolean" &&
          typeof (c as CheckResult).details === "string",
      )
    ) {
      return aggregate(result.checks);
    }
  } catch {
    // fall through to the failure below
  }

  return {
    pass: false,
    details: `Validator produced no parseable { checks: [...] } result (exit code ${exitCode}). Raw output:\n${output}`,
    checks: [],
  };
}
