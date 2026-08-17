export type SafeTextPart = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const HTTP_URL = /https?:\/\/[^\s<>"']+/giu;

export function tokenizeSafeLinks(value: string): SafeTextPart[] {
  const parts: SafeTextPart[] = [];
  let offset = 0;
  for (const match of value.matchAll(HTTP_URL)) {
    const index = match.index ?? 0;
    if (index > offset) parts.push({ type: "text", value: value.slice(offset, index) });
    let url = match[0];
    let punctuation = "";
    while (/[.,!?;:)\]]$/.test(url)) {
      punctuation = url.at(-1)! + punctuation;
      url = url.slice(0, -1);
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        parts.push({ type: "link", value: url, href: parsed.href });
      } else {
        parts.push({ type: "text", value: url });
      }
    } catch {
      parts.push({ type: "text", value: url });
    }
    if (punctuation) parts.push({ type: "text", value: punctuation });
    offset = index + match[0].length;
  }
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts.length ? parts : [{ type: "text", value }];
}

export function renderSafeText(container: HTMLElement, value: string): void {
  container.replaceChildren();
  for (const part of tokenizeSafeLinks(value)) {
    if (part.type === "text") {
      container.append(document.createTextNode(part.value));
    } else {
      const link = document.createElement("a");
      link.href = part.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = part.value;
      container.append(link);
    }
  }
}
