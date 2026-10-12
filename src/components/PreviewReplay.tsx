import { useEffect, useState } from "react";
import type { Attempt } from "../lib/types";

// Replays the visual break -> heal: each attempt the interaction driver drove
// captured the rendered DOM, and here we render those frames in a scripts-
// disabled srcdoc iframe (the captured HTML may contain the app's own <script>,
// which must NOT run in replay). This is the shareable moment — you watch the
// UI actually fix itself, not just read a pass/fail grid. All in-session; the
// only way anything leaves is the user-initiated Export download.

interface Frame {
  index: number;
  passed: boolean;
  snapshot: string;
}

function framesFrom(attempts: Attempt[]): Frame[] {
  return attempts
    .filter((a) => typeof a.previewSnapshot === "string" && a.previewSnapshot.length > 0)
    .map((a) => ({
      index: a.index,
      passed: a.status === "passed",
      snapshot: a.previewSnapshot as string,
    }));
}

// The frame where the app first flips from a failing attempt to a passing one —
// the "healed here" moment worth calling out.
function healIndex(frames: Frame[]): number {
  for (let i = 1; i < frames.length; i++) {
    if (!frames[i - 1].passed && frames[i].passed) return i;
  }
  return -1;
}

function escapeAttr(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function exportReplay(frames: Frame[]) {
  const sections = frames
    .map((f) => {
      const label = `Attempt ${f.index} — ${f.passed ? "passed" : "failed"}`;
      return `<section><h2>${label}</h2><iframe sandbox="" srcdoc="${escapeAttr(
        f.snapshot,
      )}"></iframe></section>`;
    })
    .join("\n");
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Healing replay</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#f6f7f9}section{margin:0 0 24px}h2{font-size:14px}iframe{width:100%;height:360px;border:1px solid #ccc;background:#fff;border-radius:8px}</style>
</head><body><h1>Self-healing replay</h1>${sections}</body></html>`;
  const blob = new Blob([doc], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "healing-replay.html";
  a.click();
  URL.revokeObjectURL(url);
}

export function PreviewReplay({ attempts }: { attempts: Attempt[] }) {
  const frames = framesFrom(attempts);
  const [selected, setSelected] = useState(0);
  const healed = healIndex(frames);

  // Follow the run: as new frames arrive, jump to the latest.
  useEffect(() => {
    if (frames.length > 0) setSelected(frames.length - 1);
  }, [frames.length]);

  if (frames.length === 0) return null;

  const current = frames[Math.min(selected, frames.length - 1)];

  return (
    <div className="replay">
      <div className="replay__head">
        <h2>Preview replay</h2>
        <button className="button--secondary" onClick={() => exportReplay(frames)}>
          Export
        </button>
      </div>
      <p className="replay__hint">
        The rendered UI each attempt produced. Step through to watch the bug the
        interaction driver caught heal — the same visual, no server involved.
      </p>

      <div className="replay__stage">
        <iframe
          className="replay__frame"
          sandbox=""
          srcDoc={current.snapshot}
          title={`Attempt ${current.index} preview`}
        />
        <div className="replay__caption">
          <span
            className={`replay__badge replay__badge--${current.passed ? "pass" : "fail"}`}
          >
            Attempt {current.index} · {current.passed ? "passed" : "failed"}
          </span>
          {healed >= 0 && current.index === frames[healed].index && (
            <span className="replay__healed">healed here</span>
          )}
        </div>
      </div>

      <div className="replay__strip" role="group" aria-label="Attempt previews">
        {frames.map((f, i) => (
          <button
            key={f.index}
            className={`replay__thumb${i === selected ? " replay__thumb--active" : ""}${
              healed >= 0 && i === healed ? " replay__thumb--healed" : ""
            }`}
            onClick={() => setSelected(i)}
            title={`Attempt ${f.index} · ${f.passed ? "passed" : "failed"}`}
          >
            <iframe
              className="replay__thumb-frame"
              sandbox=""
              srcDoc={f.snapshot}
              title={`Attempt ${f.index} thumbnail`}
              tabIndex={-1}
            />
            <span
              className={`replay__thumb-label replay__thumb-label--${
                f.passed ? "pass" : "fail"
              }`}
            >
              #{f.index}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
