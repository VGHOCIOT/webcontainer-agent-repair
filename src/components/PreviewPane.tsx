import { useEffect, useState } from "react";
import { getWebContainer } from "../lib/webcontainer";

const PROBE_SCRIPT_PATH = ".preview-probe.mjs";

function buildProbeScript(port: number, path: string): string {
  return `
const res = await fetch(${JSON.stringify(`http://localhost:${port}`)} + ${JSON.stringify(path)});
const body = await res.text();
const contentType = res.headers.get("content-type") || "";
console.log(JSON.stringify({ status: res.status, contentType, body }));
`;
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

interface ProbeResult {
  status: number;
  contentType: string;
  body: string;
}

// Probe the derived path from *inside* the container (a same-page fetch to the
// public tunnel URL is known to fail) via a one-shot script. We use the result
// both to decide how to render — HTML gets an iframe, anything else is
// pretty-printed — and, for JSON, as the content itself.
function usePreviewProbe(port: number | null, path: string) {
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
    if (port == null) return;

    let cancelled = false;
    (async () => {
      try {
        const webcontainer = await getWebContainer();
        await webcontainer.fs.writeFile(PROBE_SCRIPT_PATH, buildProbeScript(port, path));
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
        setResult(JSON.parse(lastLine) as ProbeResult);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [port, path]);

  return { result, error };
}

function isHtml(result: ProbeResult): boolean {
  return (
    /text\/html/i.test(result.contentType) ||
    result.body.trimStart().startsWith("<")
  );
}

export function PreviewPane({
  url,
  port,
  path,
}: {
  url: string | null;
  port: number | null;
  path: string;
}) {
  const { result, error } = usePreviewProbe(port, path);

  if (!url) {
    return (
      <div className="preview preview--empty">
        <p>No server running yet.</p>
      </div>
    );
  }

  const target = `${url}${path}`;

  return (
    <div className="preview">
      <div className="preview__bar">
        <a className="preview__url" href={target} target="_blank" rel="noreferrer">
          {target}
        </a>
      </div>
      {/* HTML → render the live page in an iframe (so its own scripts/relative
          fetches run against the tunnel origin). Otherwise pretty-print the
          probed body. */}
      {result && isHtml(result) ? (
        <iframe
          className="preview__frame"
          src={target}
          title="App preview"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      ) : (
        <div className="preview__body">
          {error && <p className="preview__error">Failed to reach server: {error}</p>}
          {!error && !result && <p className="preview__loading">Loading…</p>}
          {result && (
            <pre className="preview__json">
              {`HTTP ${result.status}\n\n${prettyBody(result.body)}`}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
