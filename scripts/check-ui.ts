import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { Endpoint, presetMinimal } from "@number0/iroh";
import { IrohNetwork } from "../host/iroh-network.js";
import { createEmbeddedGateway } from "../host/gateway.js";
import { EventEmitter, once } from "node:events";
import { randomBytes } from "node:crypto";
const endpoints: Endpoint[] = [];
const stockRelay = process.env.PULSEPARTY_TEST_RELAY_URL;
for (let i = 0; i < (stockRelay ? 0 : 3); i++) {
  const b = Endpoint.builder();
  presetMinimal(b);
  b.bindAddr("127.0.0.1:0");
  endpoints.push(await b.bind());
}
const networks = await Promise.all(
  endpoints.map((endpoint) =>
    IrohNetwork.start({
      endpoint,
      resolver: (id) => endpoints.find((e) => e.id().toString() === id)!.addr(),
    }),
  ),
);
const gateways = await Promise.all(
  networks.map(async (network) => {
    const token = randomBytes(32).toString("base64url");
    const gateway = createEmbeddedGateway({
      network,
      bridgeToken: token,
      worker: {
        events: new EventEmitter(),
        status: "Тестовый RPC адаптер",
        update() {},
        clear() {},
        stop() {},
      },
      rpcDisabled: () => true,
    });
    gateway.server.listen(0, "127.0.0.1");
    await once(gateway.server, "listening");
    return {
      ...gateway,
      url: "http://127.0.0.1:" + (gateway.server.address() as { port: number }).port,
      token,
    };
  }),
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
});
const pages = await Promise.all(
  [0, 1, 2].map(() =>
    browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" }),
  ),
);
for (let i = 0; i < pages.length; i++)
  await pages[i].addInitScript(name => Object.assign(window, { __PREVIEW_USER__: name }), ["Анна", "Борис", "Вера"][i]);
for (let i = 0; i < pages.length; i++)
  await pages[i].addInitScript(
    (value) => {
      Object.assign(window, { __PREVIEW_BRIDGE__: value });
    },
    stockRelay ? undefined : { url: gateways[i].url, token: gateways[i].token },
  );
if (stockRelay) for (const page of pages)
  await page.addInitScript((url) => Object.assign(window, { __PREVIEW_RELAY_URL__: url }), stockRelay);
const errors: string[] = [];
for (const page of pages) page.on("pageerror", (e) => errors.push(e.message));
try {
  const [a, b, c] = pages;
  await Promise.all(pages.map((p) => p.goto("http://127.0.0.1:5173")));
  const css = await readFile("dist/pulseparty/script.css", "utf8");
  const unsupported = await a.evaluate((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    const supported = new Set([
      "CSSStyleRule",
      "CSSMediaRule",
      "CSSSupportsRule",
      "CSSContainerRule",
      "CSSScopeRule",
    ]);
    const failures: string[] = [];
    const pending=Array.from(sheet.cssRules);
    while(pending.length){const rule=pending.pop()!;if(!supported.has(rule.constructor.name))failures.push(rule.constructor.name);if('cssRules'in rule)pending.push(...Array.from((rule as CSSGroupingRule).cssRules));}
    return failures;
  }, css);
  expect(unsupported).toEqual([]);
  for (const page of pages)
    await page
      .locator('.pp-launcher[data-placement="wave"]')
      .getByRole("button", { name: "Слушать вместе" })
      .click();
  await expect(a.getByLabel("Имя в Яндекс Музыке")).toHaveValue("Анна");
  await a.getByRole("button", { name: "Создать комнату", exact: true }).click();
  await expect(a.getByRole("heading", { name: "В комнате" })).toBeVisible();
  await a.getByRole("button", { name: "Создать приглашение", exact: true }).click();
  const invite = await a.locator(".pp-invite input").inputValue();
  for (const [page, name] of [
    [b, "Борис"],
    [c, "Вера"],
  ] as const) {
    await expect(page.getByLabel("Имя в Яндекс Музыке")).toHaveValue(name);
    await page.getByPlaceholder("Ссылка или код комнаты").fill(invite);
    await page.getByRole("button", { name: "Войти по приглашению", exact: true }).click();
    await expect(page.getByRole("heading", { name: "В комнате" })).toBeVisible();
  }
  await a.evaluate(() => (window as any).previewPlayer.load("123"));
  await expect(b.locator(".pp-track strong")).toHaveText("Тёплый вечер");
  await expect(c.locator(".pp-track strong")).toHaveText("Тёплый вечер");
  await expect(b.getByRole("button", { name: "Далее", exact: true })).toBeDisabled();
  await a.locator(".pp-management summary").click();
  await a.getByLabel("Кто может переключать треки").selectOption("everyone");
  await expect(b.getByRole("button", { name: "Далее", exact: true })).toBeEnabled();
  await b.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(a.locator(".pp-track strong")).toHaveText("Вторая песня");
  await expect(c.locator(".pp-track strong")).toHaveText("Вторая песня");
  await a.getByRole("button", { name: "Назад", exact: true }).click();
  await expect(c.locator(".pp-track strong")).toHaveText("Тёплый вечер");
  await a.getByRole("button", { name: "Передать управление: Борис", exact: true }).click();
  await expect(b.locator(".pp-sync")).toContainText("Вы управляете музыкой");
  await b.evaluate(() => (window as any).previewPlayer.load("456"));
  const start = Date.now();
  await expect(a.locator(".pp-track strong")).toHaveText("Вторая песня");
  await expect(c.locator(".pp-track strong")).toHaveText("Вторая песня");
  const propagationMs = Date.now() - start;
  await b.getByRole("button", { name: "Передать управление: Вера", exact: true }).click();
  await expect(c.locator(".pp-sync")).toContainText("Вы управляете музыкой");
  await c.evaluate(() => (window as any).previewPlayer.toggle());
  await expect(a.locator(".pp-track small")).toContainText("Пауза");
  await a.getByLabel("Кто может переключать треки").selectOption("owner");
  await expect(b.getByRole("button", { name: "Далее", exact: true })).toBeDisabled();
  await a.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(c.locator(".pp-track strong")).toHaveText("Тёплый вечер");
  await expect(a.locator(".pp-track strong")).toHaveText("Тёплый вечер");
  await expect(a.locator("#notice")).toBeEmpty();
  await mkdir(".shots", { recursive: true });
  for (const [width, label] of [
    [1440, "desktop"],
    [768, "tablet"],
    [360, "mobile"],
  ] as const) {
    await a.setViewportSize({ width, height: 1000 });
    await a.screenshot({ path: ".shots/" + label + ".png", fullPage: true });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await a.getByRole("dialog").boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(2);
  }
  await a.setViewportSize({ width: 1440, height: 1000 });
  await a.screenshot({ path: ".shots/dark.png", fullPage: true });
  await a.getByRole("button", { name: "Закрыть комнату", exact: true }).click();
  await a.getByRole("button", { name: "Закрыть для всех", exact: true }).click();
  await expect(b.getByRole("button", { name: "Создать комнату", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await writeFile(
    ".shots/results.json",
    JSON.stringify(
      {
        threeBrowserClients: true,
        nativeIrohPeers: stockRelay ? 0 : 3,
        sharedHttpService: !!stockRelay,
        propagationMs,
        pageErrors: errors,
        testPlayerAndDiscordAdapter: true,
        widths: [360, 768, 1440],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      propagationMs,
      notes:
        stockRelay
          ? "Three browser clients over real shared HTTP service. Test player adapter. Not real PulseSync or Discord."
          : "Three real native iroh peers. Test player and Discord adapters. Not real PulseSync or Discord.",
    }),
  );
} finally {
  await browser.close();
  for (const gateway of gateways) {
    gateway.server.close();
    gateway.server.closeAllConnections();
  }
  await Promise.all(networks.map((n) => n.stop()));
}
