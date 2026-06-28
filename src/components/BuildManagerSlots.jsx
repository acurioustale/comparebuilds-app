import { useState, useRef, useEffect, useCallback } from "react";
import Tooltip from "./Tooltip";
import { MAX_BUILD_NAME_LEN } from "../store/buildsStore";

// ─── Build slot (filled) ──────────────────────────────────────────────────────

function SlotStatus({ parsed, loading }) {
  if (loading) {
    return (
      <span className="w-16 text-right text-wow-dim text-xs animate-pulse">
        loading…
      </span>
    );
  }
  if (parsed === undefined || parsed === null) {
    return (
      <Tooltip content="Failed to parse" placement="left">
        <span className="w-4 text-center text-red-500 text-sm cursor-default select-none leading-none">
          ✕
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="w-4 text-center text-green-500 text-sm select-none leading-none">
      ✓
    </span>
  );
}

export function FilledSlot({
  index,
  name,
  label,
  summary,
  value,
  parsed,
  loading,
  onRemove,
  onRename,
  onEdit,
}) {
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef(null);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFlash(true);
      flashTimer.current = setTimeout(() => setFlash(false), 1500);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }, [value]);

  return (
    <div className="flex items-center gap-2 min-w-0">
      <SlotNumber n={index + 1} />

      {/* Editable slot name. Empty shows the computed default as a placeholder. */}
      <input
        value={name}
        onChange={(e) => onRename(e.target.value)}
        placeholder={label}
        maxLength={MAX_BUILD_NAME_LEN}
        aria-label={`Name for build ${index + 1}`}
        spellCheck={false}
        className="flex-1 min-w-0 text-xs rounded px-2 py-1.5 text-wow-gold placeholder-wow-dim outline-none transition-colors"
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid #3a2e1a",
        }}
        onFocus={(e) => {
          e.target.style.borderColor = "#8b6914";
        }}
        onBlur={(e) => {
          e.target.style.borderColor = "#3a2e1a";
        }}
      />

      <Tooltip
        content={flash ? "Copied!" : (summary ?? "Copy build string")}
        placement="bottom"
        delay={300}
      >
        <button
          onClick={handleCopy}
          aria-label="Copy build string"
          className="shrink-0 w-6 h-6 flex items-center justify-center transition-colors text-sm leading-none rounded"
          style={{ color: flash ? "#4ade80" : undefined }}
        >
          {flash ? "✓" : "⧉"}
        </button>
      </Tooltip>

      {parsed && (
        <Tooltip content="Edit build" placement="bottom" delay={300}>
          <button
            onClick={onEdit}
            aria-label={`Edit build ${index + 1}`}
            className="shrink-0 w-6 h-6 flex items-center justify-center text-wow-dim hover:text-wow-gold transition-colors text-sm leading-none rounded"
          >
            ✎
          </button>
        </Tooltip>
      )}

      <button
        onClick={onRemove}
        title="Remove"
        className="shrink-0 w-6 h-6 flex items-center justify-center text-wow-dim hover:text-red-400 transition-colors text-base leading-none rounded"
      >
        ×
      </button>

      <SlotStatus parsed={parsed} loading={loading} />
    </div>
  );
}

// ─── Empty slot (input) ───────────────────────────────────────────────────────

export function EmptySlot({ index, onAdd, errorMsg }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  const submit = useCallback(
    (text) => {
      const trimmed = text ?? value.trim();
      if (!trimmed) return;
      setValue("");
      onAdd(trimmed);
    },
    [value, onAdd],
  );

  // Auto-submit on paste so users don't need to press Enter
  const handlePaste = (e) => {
    const pasted = e.clipboardData?.getData("text/plain") ?? "";
    if (pasted.trim()) {
      e.preventDefault();
      submit(pasted.trim());
    }
  };

  // Clipboard button: read directly from OS clipboard
  const handleClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) submit(text.trim());
    } catch {
      // Permissions denied or not supported; user can paste manually
      inputRef.current?.focus();
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <SlotNumber n={index + 1} muted />

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onPaste={handlePaste}
          placeholder="Paste build string…"
          className="flex-1 font-mono text-xs rounded px-2 py-1.5 text-wow-text placeholder-wow-dim outline-none transition-colors"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid #3a2e1a",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "#8b6914";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "#3a2e1a";
          }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
        />

        <button
          onClick={handleClipboard}
          title="Paste from clipboard"
          className="wow-btn shrink-0 px-2.5 py-1.5 text-xs rounded"
        >
          Paste
        </button>

        {/* Spacer aligns with the status icon column of filled slots */}
        <span className="w-4 shrink-0" />
      </div>

      {errorMsg && (
        <p className="ml-[1.375rem] text-red-400 text-xs leading-snug pl-2">
          {errorMsg}
        </p>
      )}
    </div>
  );
}

// Shared slot number label
function SlotNumber({ n, muted = false }) {
  return (
    <span
      className={[
        "shrink-0 w-4 text-right text-xs tabular-nums select-none",
        muted ? "text-wow-dim" : "text-wow-muted",
      ].join(" ")}
    >
      {n}
    </span>
  );
}
