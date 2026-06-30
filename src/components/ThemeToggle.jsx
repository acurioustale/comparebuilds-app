import { memo } from "react";

const MODE_GLYPH = { auto: "◐", light: "☼", dark: "☾" };

export const ThemeToggle = memo(function ThemeToggle({ mode, next, onCycle }) {
  const label = `Theme: ${mode} — switch to ${next}`;
  return (
    <button
      type="button"
      onClick={onCycle}
      className="bg-transparent border-0 p-1 rounded text-lg leading-none cursor-pointer text-wow-muted/50 hover:text-wow-gold focus-visible:text-wow-gold transition-colors"
      aria-label={label}
      title={label}
    >
      {MODE_GLYPH[mode]}
    </button>
  );
});
