import { describe, expect, it, vi } from "vitest";
import { NotificationService, type NotificationGateway, type NotificationHandle } from "../src/application/notification-service";
import type { ProfileService } from "../src/application/profile-service";
import { makeIdea } from "./fixtures";

function setup(hour = 9) {
  let settings = { theme: "light" as const, view: "cards" as const, filters: {}, sortBy: "returnDate" as const, sortDirection: "asc" as const, notificationsEnabled: true, notifiedOn: {} as Record<string, string> };
  const profiles = {
    getCurrentSettings: () => structuredClone(settings),
    updateNotificationSettings: vi.fn(async (enabled: boolean, notifiedOn?: Record<string, string>) => {
      settings = { ...settings, notificationsEnabled: enabled, notifiedOn: notifiedOn ?? settings.notifiedOn };
    }),
  } as unknown as ProfileService;
  const handlers: Array<() => void> = [];
  const show = vi.fn((_title: string, _options: NotificationOptions): NotificationHandle => ({
    onClick(handler) { handlers.push(handler); }, close: vi.fn(),
  }));
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  const gateway: NotificationGateway = { supported: true, permission: "granted", requestPermission, show };
  const open = vi.fn();
  const service = new NotificationService(profiles, open, gateway, () => new Date(2026, 7, 18, hour, 5));
  return { service, profiles, gateway, show, requestPermission, handlers, open, getSettings: () => settings };
}

describe("локальные уведомления", () => {
  it("запрашивает системное разрешение только после явного включения", async () => {
    const context = setup();
    expect(context.requestPermission).not.toHaveBeenCalled();
    await expect(context.service.enable()).resolves.toBe("granted");
    expect(context.requestPermission).toHaveBeenCalledOnce();
  });

  it("создаёт тестовое уведомление без изменения идей", () => {
    const context = setup();
    context.service.showTest();
    expect(context.show).toHaveBeenCalledWith("Время идеи — Тест", expect.objectContaining({ tag: "vremya-idei-test" }));
  });

  it("не уведомляет до 09:00", async () => {
    const context = setup(8);
    const idea = { ...makeIdea(), returnDate: "2026-08-18" };
    expect(await context.service.checkDueIdeas([idea])).toBe(0);
    expect(context.show).not.toHaveBeenCalled();
  });

  it("уведомляет отдельно, не повторяет в тот же день и открывает идею по нажатию", async () => {
    const context = setup();
    const ideas = [
      { ...makeIdea("profile-1", "one"), title: "Первая", returnDate: "2026-08-18" },
      { ...makeIdea("profile-1", "two"), title: "Вторая", returnDate: "2026-08-17" },
    ];
    expect(await context.service.checkDueIdeas(ideas)).toBe(2);
    expect(context.show).toHaveBeenCalledTimes(2);
    expect(await context.service.checkDueIdeas(ideas)).toBe(0);
    context.handlers[0]?.();
    expect(context.open).toHaveBeenCalledWith("one");
    expect(context.getSettings().notifiedOn).toEqual({ one: "2026-08-18", two: "2026-08-18" });
  });
});
