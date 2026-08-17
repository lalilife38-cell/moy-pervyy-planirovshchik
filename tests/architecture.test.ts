import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const fullPath = join(directory, name);
    return statSync(fullPath).isDirectory() ? sourceFiles(fullPath) : [fullPath];
  });
}

describe("границы архитектуры и приватность", () => {
  const sourceRoot = resolve("src");
  const files = sourceFiles(sourceRoot).filter((file) => file.endsWith(".ts"));

  it("использует Local Storage только для глобальных флагов приветствия и темы", () => {
    const violations = files.filter((file) => {
      const relativePath = relative(sourceRoot, file).replaceAll("\\", "/");
      return relativePath !== "ui/app.ts" && /\blocalStorage\b/.test(readFileSync(file, "utf8"));
    });
    expect(violations.map((file) => relative(sourceRoot, file))).toEqual([]);
    const appSource = readFileSync(resolve("src/ui/app.ts"), "utf8");
    expect(appSource.match(/localStorage\.(?:getItem|setItem)/g)).toHaveLength(4);
    expect(appSource.match(/WELCOME_FLAG_KEY/g)?.length).toBeGreaterThanOrEqual(3);
    expect(appSource.match(/THEME_FLAG_KEY/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("разрешает прямой IndexedDB только слою хранения", () => {
    const violations = files.filter((file) => {
      const relativePath = relative(sourceRoot, file).replaceAll("\\", "/");
      return !relativePath.startsWith("storage/") && /\bindexedDB\b/.test(readFileSync(file, "utf8"));
    });
    expect(violations.map((file) => relative(sourceRoot, file))).toEqual([]);
  });

  it("не содержит внешних сетевых ресурсов и секретов", () => {
    const contents = [
      resolve("index.html"),
      resolve("src/style.css"),
      resolve("public/manifest.webmanifest"),
      resolve("public/service-worker.js"),
      ...files,
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(contents).not.toMatch(/<script[^>]+https?:|<link[^>]+https?:|fetch\(["']https?:|api[_-]?key|secret[_-]?key/i);
  });
});
