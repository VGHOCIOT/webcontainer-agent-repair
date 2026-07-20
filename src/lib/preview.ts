// Derive the representative preview URL path from the *generated validator
// script* — no extra AI call. The validator already probes the app's real
// endpoints (the system prompt tells it to hit concrete requests), so its first
// probed path is a good "show me the app working" URL: "/items?page=1&limit=5"
// for the REST spec, "/" for a page app. Whether to render it as a page or
// pretty-print JSON is decided at runtime from the response Content-Type, so
// this only needs the path.
const PATH_PATTERNS: RegExp[] = [
  /\$\{base\}(\/[^\s`"'\\)]*)/, // `${base}/items?page=1&limit=5`
  /\bbase\s*\+\s*[`"'](\/[^`"']*)/, // base + "/items?..."
  /localhost:\$\{[^}]+\}(\/[^\s`"'\\)]*)/, // `http://localhost:${port}/items`
  /localhost:\d+(\/[^\s`"'\\)]*)/, // http://localhost:3000/items
];

export function derivePreviewPath(validatorScript: string): string {
  for (const re of PATH_PATTERNS) {
    const match = validatorScript.match(re);
    if (match && match[1]) return match[1];
  }
  return "/";
}
