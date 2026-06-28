import { useRef, useState } from "react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useListNavigation,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
} from "@floating-ui/react";

// Status → label for a copy action's button. Server copy has a "Saving…" busy
// state; the client and SimC copies are synchronous so they skip it.
function statusLabel(status, idle, busy) {
  if (status === "copying") return busy;
  if (status === "copied") return "Copied!";
  if (status === "error") return "Failed";
  return idle;
}

// Status → inline colour for the label (gold idle, green done, red failed).
function statusColor(status) {
  if (status === "copied") return "#4ade80";
  if (status === "error") return "#f87171";
  return "#c8a84b";
}

/**
 * The single share/export entry point: a dropdown collapsing the short link,
 * the self-contained permalink, and the SimC profileset behind one button, each
 * row carrying a one-line description of what it's for.
 *
 * Built on @floating-ui/react (as Tooltip is) so it gets dismiss-on-Escape and
 * outside-click, arrow-key roving focus across the items, and proper
 * menu/menuitem roles — rather than a hand-rolled outside-click listener.
 */
export default function ExportMenu({
  onShareServer,
  onShareClient,
  onShareSimc,
  serverStatus,
  clientStatus,
  simcStatus,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(null);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: "top-end",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const items = [
    {
      key: "server",
      label: statusLabel(serverStatus, "Copy short link", "Saving…"),
      desc: "Best for Discord / Reddit (creates a clean ?id=... link)",
      onSelect: onShareServer,
      status: serverStatus,
    },
    {
      key: "client",
      label: statusLabel(clientStatus, "Copy instant link", "Saving…"),
      desc: "Standalone URL with zero server dependency",
      onSelect: onShareClient,
      status: clientStatus,
    },
    {
      key: "simc",
      label: statusLabel(simcStatus, "Copy SimC profileset", "Saving…"),
      desc: "Paste into Raidbots / SimulationCraft to sim all builds",
      onSelect: onShareSimc,
      status: simcStatus,
    },
  ];

  const listRef = useRef([]);
  // Don't let keyboard navigation land on an item mid-copy.
  const disabledIndices = items
    .map((it, i) => (it.status !== "idle" ? i : -1))
    .filter((i) => i >= 0);

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "menu" });
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    loop: true,
    disabledIndices,
  });

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions(
    [click, dismiss, role, listNav],
  );

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps()}
        className="wow-btn px-4 py-2 text-xs rounded select-none flex items-center gap-1.5"
      >
        <span>Export / Share</span>
        <span className="text-[10px] opacity-70">{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              className="w-72 wow-panel p-1.5 rounded shadow-xl border border-[#3a2e1a] z-50 flex flex-col gap-1 text-left"
            >
              {items.map((item, i) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  ref={(node) => {
                    listRef.current[i] = node;
                  }}
                  tabIndex={activeIndex === i ? 0 : -1}
                  disabled={item.status !== "idle"}
                  {...getItemProps({
                    onClick() {
                      item.onSelect?.();
                      setIsOpen(false);
                    },
                  })}
                  className="w-full p-2.5 rounded hover:bg-[#251b0d] focus:bg-[#251b0d] outline-none transition-colors flex flex-col items-start gap-1 select-none text-left border border-transparent hover:border-[#3a2e1a]/50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span
                    className="text-xs font-semibold tracking-wider uppercase"
                    style={{ color: statusColor(item.status) }}
                  >
                    {item.label}
                  </span>
                  <span className="text-[11px] text-wow-muted leading-normal font-normal normal-case tracking-normal">
                    {item.desc}
                  </span>
                </button>
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
