export function PreviewPane({ url }: { url: string | null }) {
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
      <iframe
        className="preview__frame"
        title="app preview"
        src={testUrl}
        sandbox="allow-same-origin allow-scripts"
      />
    </div>
  );
}
