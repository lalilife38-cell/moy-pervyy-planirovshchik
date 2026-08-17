import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  compareCalendarDates,
  formatCalendarDate,
  isCalendarDate,
  toLocalCalendarDate,
} from "../src/domain/dates";

describe("локальные календарные даты", () => {
  it("проверяет реальные даты и формат YYYY-MM-DD", () => {
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2025-02-29")).toBe(false);
    expect(isCalendarDate("17.08.2026")).toBe(false);
  });

  it("не преобразует выбранный день через UTC", () => {
    const local = new Date(2026, 7, 17, 0, 5);
    expect(toLocalCalendarDate(local)).toBe("2026-08-17");
    expect(formatCalendarDate("2026-08-17")).toBe("17.08.2026");
  });

  it("считает календарные дни через границы месяцев и високосный год", () => {
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addCalendarDays("2024-02-28", 7)).toBe("2024-03-06");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("сравнивает даты без времени", () => {
    expect(compareCalendarDates("2026-08-17", "2026-08-18")).toBeLessThan(0);
    expect(compareCalendarDates("2026-08-17", "2026-08-17")).toBe(0);
  });
});
