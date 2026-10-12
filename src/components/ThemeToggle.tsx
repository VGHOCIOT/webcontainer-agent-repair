import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "webcontainer-agent-repair:theme";

// Initial theme: the user's saved choice, else the OS preference. Once the user
// toggles, their choice is pinned (data-theme wins over the media query).
function initialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title="Toggle light / dark"
    >
      {theme === "dark" ? "☾ Dark" : "☀ Light"}
    </button>
  );
}
