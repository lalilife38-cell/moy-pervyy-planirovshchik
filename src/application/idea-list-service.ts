import { addCalendarDays, compareCalendarDates } from "../domain/dates";
import type { Idea, IdeaStatus, Priority, ProfileSettings } from "../domain/types";

export type IdeaSection = "today" | "upcoming" | "all" | "postponed" | "inProgress" | "archive";
export type DueFilter = "withoutDate" | "overdue" | "today" | "upcoming" | "later";

export interface IdeaFilters {
  category: string[];
  priority: Priority[];
  complexity: Array<"simple" | "complex">;
  status: IdeaStatus[];
  due: DueFilter[];
}

export interface IdeaListOptions {
  section: IdeaSection;
  query: string;
  filters: IdeaFilters;
  sortBy: ProfileSettings["sortBy"];
  sortDirection: ProfileSettings["sortDirection"];
  today: string;
}

export const EMPTY_FILTERS: IdeaFilters = Object.freeze({
  category: [],
  priority: [],
  complexity: [],
  status: [],
  due: [],
});

export const STATUS_LABELS: Record<IdeaStatus, string> = {
  new: "Новая",
  postponed: "Отложена",
  review: "Пора рассмотреть",
  inProgress: "В работе",
  completed: "Выполнена",
  rejected: "Отказался",
};

export const SECTION_LABELS: Record<IdeaSection, string> = {
  today: "Сегодня",
  upcoming: "Ближайшие",
  all: "Все идеи",
  postponed: "Отложенные",
  inProgress: "В работе",
  archive: "Архив",
};

export function filtersFromSettings(value: Record<string, string[]>): IdeaFilters {
  return {
    category: [...(value.category ?? [])],
    priority: (value.priority ?? []).filter((item): item is Priority => ["low", "medium", "high"].includes(item)),
    complexity: (value.complexity ?? []).filter((item): item is "simple" | "complex" => ["simple", "complex"].includes(item)),
    status: (value.status ?? []).filter((item): item is IdeaStatus => Object.hasOwn(STATUS_LABELS, item)),
    due: (value.due ?? []).filter((item): item is DueFilter => ["withoutDate", "overdue", "today", "upcoming", "later"].includes(item)),
  };
}

export function filtersToSettings(value: IdeaFilters): Record<string, string[]> {
  return {
    category: [...value.category],
    priority: [...value.priority],
    complexity: [...value.complexity],
    status: [...value.status],
    due: [...value.due],
  };
}

export function isArchived(idea: Idea): boolean {
  return idea.status === "completed" || idea.status === "rejected";
}

export function isOverdue(idea: Idea, today: string): boolean {
  return !isArchived(idea) && idea.returnDate !== null && compareCalendarDates(idea.returnDate, today) < 0;
}

export function sectionContains(idea: Idea, section: IdeaSection, today: string): boolean {
  const active = !isArchived(idea);
  if (section === "archive") return !active;
  if (!active) return false;
  if (section === "all") return true;
  if (section === "postponed") return idea.status === "postponed";
  if (section === "inProgress") return idea.status === "inProgress";
  if (!idea.returnDate) return false;
  if (section === "today") return compareCalendarDates(idea.returnDate, today) <= 0;
  return compareCalendarDates(idea.returnDate, today) > 0 &&
    compareCalendarDates(idea.returnDate, addCalendarDays(today, 7)) <= 0;
}

export function sectionCounts(ideas: Idea[], today: string): Record<IdeaSection, number> {
  return {
    today: ideas.filter((idea) => sectionContains(idea, "today", today)).length,
    upcoming: ideas.filter((idea) => sectionContains(idea, "upcoming", today)).length,
    all: ideas.filter((idea) => sectionContains(idea, "all", today)).length,
    postponed: ideas.filter((idea) => sectionContains(idea, "postponed", today)).length,
    inProgress: ideas.filter((idea) => sectionContains(idea, "inProgress", today)).length,
    archive: ideas.filter((idea) => sectionContains(idea, "archive", today)).length,
  };
}

function dueMatches(idea: Idea, selected: DueFilter[], today: string): boolean {
  if (!selected.length) return true;
  if (!idea.returnDate) return selected.includes("withoutDate");
  const comparison = compareCalendarDates(idea.returnDate, today);
  const lastUpcoming = addCalendarDays(today, 7);
  return (comparison < 0 && selected.includes("overdue")) ||
    (comparison === 0 && selected.includes("today")) ||
    (comparison > 0 && compareCalendarDates(idea.returnDate, lastUpcoming) <= 0 && selected.includes("upcoming")) ||
    (compareCalendarDates(idea.returnDate, lastUpcoming) > 0 && selected.includes("later"));
}

function filterMatches(idea: Idea, filters: IdeaFilters, today: string): boolean {
  return (!filters.category.length || filters.category.includes(idea.categoryId)) &&
    (!filters.priority.length || filters.priority.includes(idea.priority)) &&
    (!filters.complexity.length || filters.complexity.includes(idea.complexity)) &&
    (!filters.status.length || filters.status.includes(idea.status)) &&
    dueMatches(idea, filters.due, today);
}

function compareIdeas(left: Idea, right: Idea, sortBy: ProfileSettings["sortBy"], direction: ProfileSettings["sortDirection"]): number {
  if (sortBy === "returnDate") {
    if (left.returnDate === null) return right.returnDate === null ? 0 : 1;
    if (right.returnDate === null) return -1;
  }
  let result = 0;
  if (sortBy === "priority") {
    const rank: Record<Priority, number> = { low: 1, medium: 2, high: 3 };
    result = rank[left.priority] - rank[right.priority];
  } else {
    result = String(left[sortBy] ?? "").localeCompare(String(right[sortBy] ?? ""));
  }
  if (result === 0) result = left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  return direction === "asc" ? result : -result;
}

export function selectIdeas(ideas: Idea[], options: IdeaListOptions): Idea[] {
  const query = options.query.trim().toLocaleLowerCase("ru-RU");
  return ideas
    .filter((idea) => sectionContains(idea, options.section, options.today))
    .filter((idea) => !query || `${idea.title}\n${idea.description}`.toLocaleLowerCase("ru-RU").includes(query))
    .filter((idea) => filterMatches(idea, options.filters, options.today))
    .sort((left, right) => compareIdeas(left, right, options.sortBy, options.sortDirection));
}

export function hasActiveFilters(filters: IdeaFilters): boolean {
  return Object.values(filters).some((values) => values.length > 0);
}
