import type { ReactNode } from "react";
export function Button({
  children,
  onClick,
  disabled,
  variant,
}: {
  children: ReactNode;
  onClick?: () => unknown;
  disabled?: boolean;
  variant?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick?.()}
      style={
        variant === "outline" || variant === "text"
          ? {}
          : {
              background: "var(--pp-yellow)",
              color: "#171714",
              borderColor: "var(--pp-yellow)",
              fontWeight: 700,
            }
      }
    >
      {children}
    </button>
  );
}
