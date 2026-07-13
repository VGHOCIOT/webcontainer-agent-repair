import { useEffect, useState } from "react";
import { getWebContainer } from "../lib/webcontainer";

const PROBE_SCRIPT_PATH = ".preview-probe.mjs";

function buildProbeScript(port: number): string {
  return `
const res = await fetch("http://localhost:${port}/items?page=1&limit=5");
const body = await res.text();
console.log(JSON.stringify({ status: res.status, body }));
`;
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// The iframe below points at the WebContainer's public tunnel URL, a
// different origin than this app, so no CSS here can reach the text it
// renders. Rather than trust the browser's own (occasionally illegible,
// e.g. white-on-white in some dark-mode configs) rendering of that
// cross-origin response, we fetch it ourselves via a script run inside the
// container — the same loopback-fetch trick validate.ts uses, since a
// same-page fetch() to the public tunnel URL is known to fail — and render
// it in our own styled <pre>.
function usePreviewProbe(port: number | null) {
  const [result, setResult] = useState<{ status: number; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
    if (port == null) return;

    let cancelled = false;
    (async () => {
      try {
        const webcontainer = await getWebContainer();
        await webcontainer.fs.writeFile(PROBE_SCRIPT_PATH, buildProbeScript(port));
        const process = await webcontainer.spawn("node", [PROBE_SCRIPT_PATH]);

        let output = "";
        await process.output.pipeTo(
          new WritableStream({
            write(chunk) {
              output += chunk;
            },
          }),
        );
        await process.exit;
        if (cancelled) return;

        const lastLine = output.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(lastLine) as { status: number; body: string };
        setResult(parsed);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [port]);

  return { result, error };
}

export function PreviewPane({
  url,
  port,
}: {
  url: string | null;
  port: number | null;
}) {
  const { result, error } = usePreviewProbe(port);

  if (!url) {
    return (
      <div className="preview preview--empty">
        <p>No server running yet.</p>
      </div>
    );
  }

  const testUrl = `${url}/items?page=1&limit=5`;

  return (
    <div className="preview">
      <div className="preview__bar">
        <span className="preview__url">{testUrl}</span>
      </div>
      <div className="preview__body">
        {error && <p className="preview__error">Failed to reach server: {error}</p>}
        {!error && !result && <p className="preview__loading">Loading…</p>}
        {result && (
          <pre className="preview__json">
            {`HTTP ${result.status}\n\n${prettyBody(result.body)}`}
          </pre>
        )}
      </div>
    </div>
  );
}
