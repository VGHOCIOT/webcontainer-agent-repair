import type { GeneratedFile } from "./types";

// Shared building blocks for grader fixtures (reference apps, valid variants and
// known-bad mutants): a package.json, an HTML page shell, a tiny http server, and
// the one-line mutation helper. Fixtures only — never shown to the builder model.
// Client scripts avoid template literals and backticks so they embed in strings.

export const PACKAGE_JSON: GeneratedFile = {
  path: "package.json",
  contents: JSON.stringify(
    { name: "reference-app", version: "1.0.0", scripts: { start: "node index.js" } },
    null,
    2,
  ),
};

export function page(body: string, script: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>' +
    body +
    "<script>" +
    script +
    "</script></body></html>"
  );
}

// A server whose routes are: "/" -> html, plus whatever `extraRoutes` handles.
// `extraRoutes(url, res)` returns true if it handled the request.
export function server(html: string, extraRoutes: string): string {
  return [
    'const http = require("http");',
    "const HTML = " + JSON.stringify(html) + ";",
    "function json(res, status, body) {",
    '  res.writeHead(status, { "Content-Type": "application/json" });',
    "  res.end(JSON.stringify(body));",
    "}",
    "const server = http.createServer((req, res) => {",
    '  const url = new URL(req.url, "http://localhost");',
    '  if (req.method === "GET" && url.pathname === "/") {',
    '    res.writeHead(200, { "Content-Type": "text/html" });',
    "    return res.end(HTML);",
    "  }",
    extraRoutes,
    '  res.writeHead(404, { "Content-Type": "text/plain" });',
    '  res.end("Not found");',
    "});",
    "const PORT = process.env.PORT || 3000;",
    'server.listen(PORT, () => console.log("Server ready"));',
  ].join("\n");
}

// A named set of files: a known-bad mutant or a known-good variant of a reference app.
export interface NamedFiles {
  name: string;
  files: GeneratedFile[];
}

export function files(index: string): GeneratedFile[] {
  return [PACKAGE_JSON, { path: "index.js", contents: index }];
}

// Replace the single line containing `needle` (the line must exist exactly once,
// so a mutant can't silently stop mutating if the reference is edited).
export function swapLine(lines: string[], needle: string, replacement: string): string[] {
  const hits = lines.filter((l) => l.includes(needle)).length;
  if (hits !== 1) throw new Error(`referenceApps: expected exactly one line containing ${JSON.stringify(needle)}, found ${hits}`);
  return lines.map((l) => (l.includes(needle) ? replacement : l));
}

export const restFiles = (lines: string[]) => files(lines.join("\n"));
export const appFiles = (body: string, script: string[], api: string) =>
  files(server(page(body, script.join("\n")), api));

