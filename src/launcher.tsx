import { Button } from "@pulsesync/addon-sdk";

export function PartyLauncher({
  open,
  placement = "bar",
}: {
  open: () => void | Promise<void>;
  placement?: "bar" | "wave" | "fullscreen" | "fallback";
}) {
  return (
    <span className="pp-launcher" data-placement={placement}>
      {placement === "fallback" ? <button type="button" onClick={() => void open()}>
        Слушать вместе
      </button> : <Button icon="users" size="s" color="primary" onClick={open}>
        Слушать вместе
      </Button>}
    </span>
  );
}
