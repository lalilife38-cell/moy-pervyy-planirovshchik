import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  filtersFromSettings,
  sectionCounts,
  sectionContains,
  selectIdeas,
  type IdeaFilters,
} from "../src/application/idea-list-service";
import type { Idea } from "../src/domain/types";
import { makeIdea } from "./fixtures";

const today = "2026-08-18";

function idea(id: string, patch: Partial<Idea> = {}): Idea {
  return { ...makeIdea("profile-1", id), title: `Идея ${id}`, ...patch };
}

describe("разделы, поиск, фильтры и сортировка", () => {
  it("точно определяет Сегодня, Ближайшие и идеи без даты", () => {
    expect(sectionContains(idea("overdue", { returnDate: "2026-08-17" }), "today", today)).toBe(true);
    expect(sectionContains(idea("today", { returnDate: today }), "today", today)).toBe(true);
    expect(sectionContains(idea("tomorrow", { returnDate: "2026-08-19" }), "upcoming", today)).toBe(true);
    expect(sectionContains(idea("seventh", { returnDate: "2026-08-25" }), "upcoming", today)).toBe(true);
    expect(sectionContains(idea("eighth", { returnDate: "2026-08-26" }), "upcoming", today)).toBe(false);
    expect(sectionContains(idea("none", { returnDate: null }), "today", today)).toBe(false);
    expect(sectionContains(idea("none", { returnDate: null }), "all", today)).toBe(true);
  });

  it("считает статусные разделы и единый архив", () => {
    const ideas = [
      idea("new"), idea("postponed", { status: "postponed" }), idea("work", { status: "inProgress" }),
      idea("done", { status: "completed" }), idea("reject", { status: "rejected" }),
    ];
    expect(sectionCounts(ideas, today)).toMatchObject({ all: 3, postponed: 1, inProgress: 1, archive: 2 });
  });

  it("ищет только в названии и описании без учёта регистра", () => {
    const ideas = [
      idea("one", { title: "Купить БИЛЕТЫ", description: "Поезд" }),
      idea("two", { title: "Маршрут", description: "билеты на самолёт" }),
      idea("three", { title: "Другое", description: "Нет", notes: "билеты" }),
    ];
    const result = selectIdeas(ideas, { section: "all", query: "БиЛеТы", filters: filtersFromSettings({}), sortBy: "createdAt", sortDirection: "asc", today });
    expect(result.map(({ id }) => id)).toEqual(["one", "two"]);
  });

  it("применяет И между группами и ИЛИ внутри группы", () => {
    const filters: IdeaFilters = {
      ...filtersFromSettings({}),
      category: ["category-1", "category-2"],
      priority: ["high"],
      complexity: ["simple"],
    };
    const ideas = [
      idea("match-1", { categoryId: "category-1", priority: "high", complexity: "simple" }),
      idea("match-2", { categoryId: "category-2", priority: "high", complexity: "simple" }),
      idea("wrong-priority", { categoryId: "category-1", priority: "low", complexity: "simple" }),
      idea("wrong-complexity", { categoryId: "category-2", priority: "high", complexity: "complex" }),
    ];
    expect(selectIdeas(ideas, { section: "all", query: "", filters, sortBy: "createdAt", sortDirection: "asc", today }).map(({ id }) => id))
      .toEqual(["match-1", "match-2"]);
  });

  it("фильтрует сроки и архив по результату", () => {
    const active = [
      idea("none", { returnDate: null }), idea("late", { returnDate: "2026-08-17" }),
      idea("near", { returnDate: "2026-08-22" }), idea("later", { returnDate: "2026-08-30" }),
    ];
    const due = { ...filtersFromSettings({}), due: ["withoutDate", "later"] as IdeaFilters["due"] };
    expect(selectIdeas(active, { section: "all", query: "", filters: due, sortBy: "returnDate", sortDirection: "asc", today }).map(({ id }) => id))
      .toEqual(["later", "none"]);
    const archiveFilter = { ...filtersFromSettings({}), status: ["rejected"] as IdeaFilters["status"] };
    const archive = [idea("done", { status: "completed" }), idea("no", { status: "rejected" })];
    expect(selectIdeas(archive, { section: "archive", query: "", filters: archiveFilter, sortBy: "createdAt", sortDirection: "asc", today }).map(({ id }) => id))
      .toEqual(["no"]);
  });

  it("сортирует в обоих направлениях, оставляя идеи без даты в конце", () => {
    const ideas = [idea("none", { returnDate: null }), idea("early", { returnDate: "2026-08-19" }), idea("late", { returnDate: "2026-08-25" })];
    const options = { section: "all" as const, query: "", filters: filtersFromSettings({}), sortBy: "returnDate" as const, today };
    expect(selectIdeas(ideas, { ...options, sortDirection: "asc" }).map(({ id }) => id)).toEqual(["early", "late", "none"]);
    expect(selectIdeas(ideas, { ...options, sortDirection: "desc" }).map(({ id }) => id)).toEqual(["late", "early", "none"]);
  });

  it("обрабатывает 1000 идей быстрее целевого порога", () => {
    const ideas = Array.from({ length: 1000 }, (_, index) => idea(String(index), { title: index % 10 === 0 ? `Найти ${index}` : `Обычная ${index}` }));
    const started = performance.now();
    const result = selectIdeas(ideas, { section: "all", query: "найти", filters: EMPTY_FILTERS, sortBy: "updatedAt", sortDirection: "desc", today });
    expect(result).toHaveLength(100);
    expect(performance.now() - started).toBeLessThan(300);
  });
});
