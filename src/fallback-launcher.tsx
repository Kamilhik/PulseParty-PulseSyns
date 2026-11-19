import { useEffect, useState } from "react";
import { PartyLauncher } from "./launcher.js";

/** Uses rendered buttons, rather than a version-specific player container. */
export function primaryLauncherVisible(root: Document = document): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>(
    '.pp-launcher:not([data-placement="fallback"]) button',
  )).some(button => {
    const rect = button.getBoundingClientRect();
    const visible = typeof button.checkVisibility === "function"
      ? button.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
      : getComputedStyle(button).visibility !== "hidden" && getComputedStyle(button).display !== "none";
    return visible &&
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < root.documentElement.clientHeight && rect.left < root.documentElement.clientWidth;
  });
}

export function FallbackLauncher({ open }: { open: () => void | Promise<void> }) {
  const [visible, setVisible] = useState(() => !primaryLauncherVisible());
  useEffect(() => {
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setVisible(!primaryLauncherVisible()));
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    window.addEventListener("resize", check);
    document.addEventListener("visibilitychange", check);
    // Also catches ancestor layout changes without replacing a player node.
    const timer = window.setInterval(check, 1000);
    check();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", check);
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
      cancelAnimationFrame(frame);
    };
  }, []);
  return visible ? <PartyLauncher placement="fallback" open={open} /> : null;
}
