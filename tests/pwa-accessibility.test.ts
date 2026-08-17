import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function pngDimensions(path: string): [number, number] {
  const image = readFileSync(resolve(path));
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
}

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe("PWA и итоговая доступность", () => {
  const manifest = JSON.parse(readFileSync(resolve("public/manifest.webmanifest"), "utf8"));
  const worker = readFileSync(resolve("public/service-worker.js"), "utf8");
  const pwa = readFileSync(resolve("src/pwa.ts"), "utf8");
  const styles = readFileSync(resolve("src/style.css"), "utf8");
  const html = readFileSync(resolve("index.html"), "utf8");

  it("содержит корректный русскоязычный standalone manifest", () => {
    expect(manifest).toMatchObject({
      name: "Время идеи",
      short_name: "Время идеи",
      lang: "ru",
      display: "standalone",
      start_url: "./",
      scope: "./",
      theme_color: "#73528b",
      background_color: "#f7f3fa",
    });
    expect(html).toContain('rel="manifest" href="./manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
  });

  it("поставляет настоящие PNG-иконки 192 и 512 пикселей", () => {
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512"]);
    expect(pngDimensions("public/icons/icon-192.png")).toEqual([192, 192]);
    expect(pngDimensions("public/icons/icon-512.png")).toEqual([512, 512]);
  });

  it("кэширует только локальную оболочку и безопасные статические назначения", () => {
    expect(worker).toContain('url.origin !== self.location.origin');
    expect(worker).toContain('request.method !== "GET"');
    expect(worker).toContain('["document", "script", "style", "image", "font"]');
    expect(worker).toContain('caches.match(localPath("index.html"))');
    expect(worker).not.toContain('"/index.html"');
    expect(worker).toContain("indexText.matchAll");
    expect(worker).toContain("await cache.addAll([...APP_SHELL, ...builtAssets])");
    expect(worker).not.toMatch(/indexedDB|localStorage|profiles|ideas|drafts|diagnostics/);
    expect(worker).not.toMatch(/https?:\/\//);
  });

  it("поддерживает безопасное обновление Service Worker без очистки IndexedDB", () => {
    expect(worker).toContain("SKIP_WAITING");
    expect(worker).toContain("self.clients.claim()");
    expect(pwa).toContain('worker.state === "installed"');
    expect(pwa).toContain('navigator.serviceWorker.addEventListener("controllerchange"');
    expect(pwa).not.toMatch(/indexedDB\.deleteDatabase|localStorage\.clear/);
  });

  it("показывает установку только после события браузера и имеет запасную инструкцию", () => {
    expect(pwa).toContain('window.addEventListener("beforeinstallprompt"');
    expect(pwa).toContain("this.installPrompt ?");
    expect(pwa).toContain("Safari на iPhone или iPad");
    expect(pwa).toContain("Если команды нет, используйте приложение во вкладке");
  });

  it("объясняет офлайн-сбой без технического стека и записывает его через безопасный обработчик", () => {
    expect(pwa).toContain('this.errorReporter(error, "registerServiceWorker")');
    expect(pwa).toContain("Не удалось включить офлайн-режим");
    expect(pwa).not.toMatch(/error\.stack|String\(error\)/);
  });

  it("задаёт фокус, сенсорные области, адаптивность и сокращение анимаций", () => {
    expect(styles).toMatch(/button, input \{ min-height: 44px; \}/);
    expect(styles).toMatch(/:focus-visible \{ outline: 3px solid/);
    expect(styles).toContain("@media (max-width: 600px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
    expect(html).toContain('width=device-width, initial-scale=1.0');
  });

  it("основные сочетания цветов проходят WCAG AA для обычного текста", () => {
    expect(contrast("#ffffff", "#73528b")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#251f2c", "#f7f3fa")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#f3edf6", "#25202a")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#842f3a", "#fff0f1")).toBeGreaterThanOrEqual(4.5);
  });
});
