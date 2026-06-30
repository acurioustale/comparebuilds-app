import { useShallow } from "zustand/react/shallow";
import BuildManager from "./components/BuildManager";
import MainView from "./components/MainView";
import { useBuildsStore } from "./store/buildsStore";
import { useTheme } from "./hooks/useTheme";
import { ThemeToggle } from "./components/ThemeToggle";
import { useShareRehydration } from "./hooks/useShareRehydration";

export default function App() {
  const { shareError, dismissShareError } = useShareRehydration();
  const { mode, next, cycleTheme } = useTheme();
  const { layoutHash, sharedLayoutHash } = useBuildsStore(
    useShallow((s) => ({
      layoutHash: s.layoutHash,
      sharedLayoutHash: s.sharedLayoutHash,
    })),
  );
  const patchWarning =
    layoutHash && sharedLayoutHash && layoutHash !== sharedLayoutHash;

  return (
    <div className="min-h-screen text-wow-text flex flex-col relative">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        className="wow-chrome relative py-6 px-4 text-center select-none"
        style={{
          borderBottom: "1px solid transparent",
          borderImage:
            "linear-gradient(to right, transparent 8%, rgba(200,168,75,0.55), transparent 92%) 1",
        }}
      >
        <div className="absolute right-4 top-4">
          <ThemeToggle mode={mode} next={next} onCycle={cycleTheme} />
        </div>
        <div className="flex items-center justify-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            width={50}
            height={50}
            draggable={false}
            className="shrink-0"
            style={{ filter: "drop-shadow(0 0 10px rgba(200,168,75,0.35))" }}
          />
          <h1
            className="text-[2.75rem] text-wow-gold tracking-[0.16em] leading-none"
            style={{
              fontFamily: "'FrizQuadrata', 'Palatino Linotype', serif",
              textShadow:
                "0 0 18px rgba(200,168,75,0.35), 0 2px 5px rgba(0,0,0,0.6)",
            }}
          >
            Compare Builds
          </h1>
        </div>
        <p className="text-wow-muted text-xs uppercase tracking-[0.35em] mt-2">
          WoW Talent Build Comparison
        </p>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 p-4 pt-6">
        {shareError && (
          <div
            className="max-w-2xl mx-auto mb-4 flex items-start gap-3 px-3 py-2.5 rounded text-xs"
            style={{
              background: "rgba(60,10,10,0.7)",
              border: "1px solid rgba(180,40,40,0.4)",
              color: "#ffaaaa",
            }}
          >
            <span className="flex-1">{shareError}</span>
            <button
              onClick={dismissShareError}
              className="shrink-0 transition-colors leading-none"
              style={{ color: "#ff6666" }}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {patchWarning && (
          <div
            className="max-w-2xl mx-auto mb-4 px-3 py-2.5 rounded text-xs text-center"
            style={{
              background: "rgba(60,10,10,0.7)",
              border: "1px solid rgba(180,40,40,0.4)",
              color: "#ffaaaa",
            }}
          >
            These builds were created during a previous game patch. Talent
            positions may have shifted, causing points to misalign or disappear.
          </div>
        )}
        <BuildManager />
        <MainView />
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer
        className="wow-chrome py-4 px-4 text-center space-y-0.5"
        style={{
          borderTop: "1px solid transparent",
          borderImage:
            "linear-gradient(to right, transparent 8%, rgba(200,168,75,0.45), transparent 92%) 1",
        }}
      >
        <p className="text-wow-muted text-xs">
          2026{" "}
          <a
            href="https://acurioustale.de"
            className="hover:text-wow-gold transition-colors"
          >
            acurioustale
          </a>
        </p>
        <p className="text-wow-dim text-xs">
          Built with React, Vite, and Tailwind CSS
        </p>
      </footer>
    </div>
  );
}
