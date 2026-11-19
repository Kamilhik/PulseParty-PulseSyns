// The SDK exposes the account login. The visible public nickname lives in the
// native profile component; reading its text needs no account credentials.
export function musicName(login: string | undefined, root?: Pick<Document, "querySelector">): string {
  const documentRoot = root ?? (typeof document !== "undefined" ? document : undefined);
  const nickname = documentRoot?.querySelector('[class*="UserProfile_userName__"]')?.textContent?.trim();
  return (nickname || login?.trim() || "Слушатель").slice(0, 48);
}
