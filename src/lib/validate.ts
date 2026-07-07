import type { WebContainer } from "@webcontainer/api";

const VALIDATE_SCRIPT_PATH = ".agent-validate.mjs";

// Runs the actual pagination checks as a Node script INSIDE the container,
// hitting http://localhost:<port> directly. This deliberately avoids the
// browser: fetching the public WebContainer preview URL from page JS goes
// through an external CloudFront tunnel that (empirically) only reliably
// routes real navigations (e.g. the preview pane's <iframe src>), not
// same-page fetch() calls — so validating that way produced a persistent,
// unfixable-by-the-generated-code "failed to fetch". From inside the
// container it's just a normal loopback HTTP request.
const VALIDATE_SCRIPT = `
const base = \`http://localhost:\${process.argv[2]}\`;

function fail(details) {
  console.log(JSON.stringify({ pass: false, details }));
}

async function getJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let page1;
  try {
    page1 = await getJson(\`\${base}/items?page=1&limit=5\`);
  } catch (err) {
    return fail(\`GET /items?page=1&limit=5 failed to connect: \${err.message}\`);
  }
  if (page1.status !== 200) {
    return fail(\`GET /items?page=1&limit=5 expected 200, got \${page1.status}. Body: \${JSON.stringify(page1.body)}\`);
  }
  const p1 = page1.body ?? {};
  if (!Array.isArray(p1.items) || p1.items.length !== 5) {
    return fail(\`GET /items?page=1&limit=5 expected 5 items, got: \${JSON.stringify(page1.body)}\`);
  }
  const p1Ids = p1.items.map((i) => i.id);
  if (p1Ids.join(",") !== "1,2,3,4,5") {
    return fail(\`GET /items?page=1&limit=5 expected ids [1,2,3,4,5], got [\${p1Ids.join(",")}]\`);
  }
  if (p1.total !== 47) {
    return fail(\`Expected total=47, got total=\${p1.total}\`);
  }

  let page2;
  try {
    page2 = await getJson(\`\${base}/items?page=2&limit=5\`);
  } catch (err) {
    return fail(\`GET /items?page=2&limit=5 failed to connect: \${err.message}\`);
  }
  const p2 = page2.body ?? {};
  const p2Ids = (p2.items ?? []).map((i) => i.id);
  if (p2Ids.join(",") !== "6,7,8,9,10") {
    return fail(\`GET /items?page=2&limit=5 expected ids [6,7,8,9,10] (no overlap with page 1), got [\${p2Ids.join(",")}]\`);
  }

  let pastEnd;
  try {
    pastEnd = await getJson(\`\${base}/items?page=100&limit=5\`);
  } catch (err) {
    return fail(\`GET /items?page=100&limit=5 failed to connect: \${err.message}\`);
  }
  if (pastEnd.status !== 200) {
    return fail(\`GET /items?page=100&limit=5 (past the last page) expected 200 with an empty array, got status \${pastEnd.status}: \${JSON.stringify(pastEnd.body)}\`);
  }
  const pastItems = (pastEnd.body ?? {}).items;
  if (!Array.isArray(pastItems) || pastItems.length !== 0) {
    return fail(\`GET /items?page=100&limit=5 (past the last page) expected an empty items array, got: \${JSON.stringify(pastEnd.body)}\`);
  }

  let invalid;
  try {
    invalid = await getJson(\`\${base}/items?page=abc\`);
  } catch (err) {
    return fail(\`GET /items?page=abc failed to connect: \${err.message}\`);
  }
  if (invalid.status !== 400) {
    return fail(\`GET /items?page=abc (invalid page param) expected 400, got \${invalid.status}: \${JSON.stringify(invalid.body)}\`);
  }

  console.log(JSON.stringify({ pass: true, details: "All pagination checks passed." }));
}

main().catch((err) => fail(\`Validator crashed: \${err.message}\`));
`;

/**
 * Exercises the paginated /items endpoint the spec asks for. Doubles as the
 * "did it actually work" signal the agent loop retries against — a running
 * server that fails these checks is treated the same as a crash.
 */
export async function validateApp(
  webcontainer: WebContainer,
  port: number,
): Promise<{ pass: boolean; details: string }> {
  await webcontainer.fs.writeFile(VALIDATE_SCRIPT_PATH, VALIDATE_SCRIPT);

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
    if (typeof result.pass === "boolean" && typeof result.details === "string") {
      return result;
    }
  } catch {
    // fall through to the failure below
  }

  return {
    pass: false,
    details: `Validator produced no parseable result (exit code ${exitCode}). Raw output:\n${output}`,
  };
}
