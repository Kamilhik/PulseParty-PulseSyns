import { useLayoutEffect, useRef } from "react";
import type { PartyController } from "./controller.js";
import { PartyPanel } from "./panel.js";

/** A real top-layer dialog: custom SDK modal renders do not add a backdrop themselves. */
export function PartyOverlay({
  controller,
  close,
}: {
  controller: PartyController;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="pp-overlay"
      aria-labelledby="pp-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        }
      }}
    >
      <PartyPanel controller={controller} close={close} />
    </dialog>
  );
}
