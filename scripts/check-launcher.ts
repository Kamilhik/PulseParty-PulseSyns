import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const bundle = await build({
  stdin: { contents: `
    import {createElement, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FallbackLauncher} from './src/fallback-launcher';
    import {PartyOverlay} from './src/overlay';
    import {PartyController} from './src/controller';
    const controller = new PartyController({}, 'https://rooms.example', '');
    function Fixture() {
      const [open, setOpen] = useState(false);
      return createElement('div', null,
        createElement(FallbackLauncher, {open: () => setOpen(true)}),
        open ? createElement(PartyOverlay, {controller, close: () => setOpen(false)}) : null);
    }
    createRoot(document.getElementById('root')).render(createElement(Fixture));
  `, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  alias: { "@pulsesync/addon-sdk": path.resolve("preview/sdk.tsx") },
});
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "msedge" });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.setContent('<div id="root"></div><div id="native"></div>');
  await page.addStyleTag({ content: await readFile("src/style.css", "utf8") });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const fallback = page.locator('.pp-launcher[data-placement="fallback"] button');
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(fallback).toBeVisible();
    await fallback.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Закрыть панель" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.evaluate(() => {
    document.getElementById("native")!.innerHTML = '<span class="pp-launcher" data-placement="bar"><button>Слушать вместе</button></span>';
  });
  await expect(fallback).toHaveCount(0);
  await page.evaluate(() => { document.getElementById("native")!.hidden = true; });
  await expect(fallback).toBeVisible();
  await page.evaluate(() => { document.getElementById("native")!.hidden = false; });
  await expect(fallback).toHaveCount(0);
  await page.evaluate(() => { document.getElementById("native")!.innerHTML = ""; });
  await expect(fallback).toBeVisible();
  await mkdir(".shots", { recursive: true });
  await page.screenshot({ path: ".shots/launcher-fallback.png" });
  expect(errors).toEqual([]);
  console.log("Launcher: fallback, dialog, three widths, native arrival/hide/removal passed");
} finally { await browser.close(); }
