import { describe, expect, it } from "vitest";
import { tokenizeSafeLinks } from "../src/ui/safe-text";

describe("безопасный пользовательский текст", () => {
  it("делает ссылками только HTTP(S) и сохраняет знаки препинания", () => {
    const parts = tokenizeSafeLinks("Сайт https://example.com/path, и http://example.org.");
    expect(parts.filter((part) => part.type === "link")).toEqual([
      { type: "link", value: "https://example.com/path", href: "https://example.com/path" },
      { type: "link", value: "http://example.org", href: "http://example.org/" },
    ]);
    expect(parts.map(({ value }) => value).join("")).toBe("Сайт https://example.com/path, и http://example.org.");
  });

  it("не превращает опасные протоколы и HTML в исполняемые элементы", () => {
    const source = '<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,test';
    const parts = tokenizeSafeLinks(source);
    expect(parts).toEqual([{ type: "text", value: source }]);
  });
});
