"use client";
import { useEffect, useState } from "react";
import { validTheme, resolveTheme, type Theme } from "@/lib/theme";
export default function ThemeControl() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let preference: Theme = "system";
      try {
        preference = validTheme(localStorage.getItem("pct-theme"));
      } catch {}
      setTheme(preference);
      document.documentElement.dataset.theme = resolveTheme(
        preference,
        media.matches,
      );
    };
    apply();
    media.addEventListener("change", apply);
    window.addEventListener("storage", apply);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener("storage", apply);
    };
  }, []);
  return (
    <label className="theme-label">
      Appearance
      <select
        aria-label="Theme preference"
        value={theme}
        onChange={(e) => {
          const t = validTheme(e.target.value);
          setTheme(t);
          try {
            localStorage.setItem("pct-theme", t);
          } catch {}
          document.documentElement.dataset.theme = resolveTheme(
            t,
            matchMedia("(prefers-color-scheme: dark)").matches,
          );
        }}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </label>
  );
}
