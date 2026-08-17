import { addCalendarDays, compareCalendarDates, toLocalCalendarDate } from "../domain/dates";
import type {
  ComplexDetails,
  DraftImage,
  DraftRecord,
  Idea,
  IdeaStatus,
  NestedSubtask,
  Priority,
  ReturnMode,
  StatusReason,
  Subtask,
} from "../domain/types";
import { IdeaDatabase } from "../storage/database";
import { UserInputError } from "./profile-service";

export interface IdeaInput {
  title: string;
  description: string;
  notes: string;
  categoryId: string;
  priority: Priority;
  complexity: "simple" | "complex";
  returnMode: ReturnMode;
  returnDate: string | null;
  returnWeeks: number | null;
  complexDetails: ComplexDetails;
  subtasks: Subtask[];
  image: DraftImage | null | undefined;
}

export interface LinkedSource {
  ideaId: string;
  subtaskId: string;
}

export const ALLOWED_STATUS_TRANSITIONS: Record<IdeaStatus, IdeaStatus[]> = {
  new: ["postponed", "inProgress", "completed", "rejected"],
  postponed: ["review", "inProgress", "completed", "rejected"],
  review: ["inProgress", "postponed", "completed", "rejected"],
  inProgress: ["postponed", "completed", "rejected"],
  completed: ["new"],
  rejected: ["new"],
};

const emptyComplexDetails = (): ComplexDetails => ({
  isMultiStage: null,
  expectedResult: "",
  requiredResources: "",
  blockers: "",
  firstStep: "",
  hasDeadline: null,
  deadlineComment: "",
});

export function createEmptyIdeaInput(categoryId: string): IdeaInput {
  return {
    title: "",
    description: "",
    notes: "",
    categoryId,
    priority: "medium",
    complexity: "simple",
    returnMode: null,
    returnDate: null,
    returnWeeks: null,
    complexDetails: emptyComplexDetails(),
    subtasks: [],
    image: null,
  };
}

function assertLength(value: string, minimum: number, maximum: number, message: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new UserInputError(message, field);
  }
  return normalized;
}

function validateOptionalLength(value: string, maximum: number, message: string, field: string): string {
  if (value.length > maximum) throw new UserInputError(message, field);
  return value;
}

function normalizeNestedSubtask(item: NestedSubtask): NestedSubtask {
  return {
    ...item,
    title: assertLength(item.title, 1, 200, "Название подзадачи должно содержать от 1 до 200 символов.", "subtasks"),
    description: validateOptionalLength(item.description, 1000, "Описание подзадачи не должно превышать 1000 символов.", "subtasks"),
  };
}

function normalizeSubtasks(subtasks: Subtask[]): Subtask[] {
  return subtasks.map((item) => ({
    ...normalizeNestedSubtask(item),
    children: item.children.map(normalizeNestedSubtask),
  }));
}

function normalizeComplexDetails(value: ComplexDetails): ComplexDetails {
  return {
    ...value,
    expectedResult: validateOptionalLength(value.expectedResult, 2000, "Ожидаемый результат не должен превышать 2000 символов.", "expectedResult"),
    requiredResources: validateOptionalLength(value.requiredResources, 2000, "Ресурсы не должны превышать 2000 символов.", "requiredResources"),
    blockers: validateOptionalLength(value.blockers, 2000, "Препятствия не должны превышать 2000 символов.", "blockers"),
    firstStep: validateOptionalLength(value.firstStep, 2000, "Первый шаг не должен превышать 2000 символов.", "firstStep"),
    deadlineComment: validateOptionalLength(value.deadlineComment, 500, "Комментарий о сроке не должен превышать 500 символов.", "deadlineComment"),
  };
}

function meaningfulIdea(idea: Idea) {
  const { updatedAt: _updatedAt, hasImage: _hasImage, ...meaningful } = idea;
  return meaningful;
}

function findSubtask(idea: Idea, id: string): NestedSubtask | null {
  for (const subtask of idea.subtasks) {
    if (subtask.id === id) return subtask;
    const child = subtask.children.find((item) => item.id === id);
    if (child) return child;
  }
  return null;
}

export function subtaskProgress(idea: Idea): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const subtask of idea.subtasks) {
    const leaves = subtask.children.length ? subtask.children : [subtask];
    total += leaves.length;
    completed += leaves.filter((item) => item.completed).length;
  }
  return { completed, total };
}

export class IdeaService {
  constructor(
    private readonly database: IdeaDatabase,
    private readonly activeProfileId: () => string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listIdeas(): Promise<Idea[]> {
    return this.database.listIdeas(this.requireProfileId());
  }

  async getIdea(id: string): Promise<{ idea: Idea; image: DraftImage | null }> {
    const profileId = this.requireProfileId();
    const idea = await this.database.getIdea(id);
    if (!idea || idea.profileId !== profileId) throw new UserInputError("Идея не найдена.");
    const image = await this.database.getImage(id);
    return {
      idea,
      image: image ? {
        blob: image.blob,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        savedAt: image.savedAt,
      } : null,
    };
  }

  async createIdea(input: IdeaInput, source?: LinkedSource): Promise<Idea> {
    const profileId = this.requireProfileId();
    const idea = this.buildIdea(input, profileId);
    const draftId = `${profileId}:draft_new`;
    if (source) {
      return this.database.createLinkedIdea(source.ideaId, source.subtaskId, idea, input.image ?? null, draftId);
    }
    return this.database.saveIdeaBundle(idea, input.image ?? null, draftId);
  }

  async updateIdea(id: string, input: IdeaInput): Promise<Idea> {
    const current = (await this.getIdea(id)).idea;
    const candidate = this.buildIdea(input, current.profileId, current);
    const hasMeaningfulChanges = JSON.stringify(meaningfulIdea(candidate)) !== JSON.stringify(meaningfulIdea(current));
    const updated = {
      ...candidate,
      updatedAt: hasMeaningfulChanges || input.image !== undefined ? this.now().toISOString() : current.updatedAt,
    };
    return this.database.saveIdeaBundle(updated, input.image, `${current.profileId}:draft_edit_${id}`);
  }

  async deleteIdea(id: string): Promise<void> {
    await this.database.deleteIdeaConnected(this.requireProfileId(), id);
  }

  async transitionIdea(id: string, target: IdeaStatus, reason: StatusReason = "manual"): Promise<Idea> {
    const current = (await this.getIdea(id)).idea;
    return this.database.saveIdeaBundle(this.buildTransition(current, target, reason), undefined);
  }

  private buildTransition(current: Idea, target: IdeaStatus, reason: StatusReason): Idea {
    if (!ALLOWED_STATUS_TRANSITIONS[current.status].includes(target)) {
      throw new UserInputError("Этот переход статуса недоступен для текущей идеи.");
    }
    if (target === "review" && reason !== "date") {
      throw new UserInputError("Статус «Пора рассмотреть» назначается автоматически по дате.");
    }
    if (target === "new" && reason !== "restore") {
      throw new UserInputError("Архивную идею можно только восстановить.");
    }
    const timestamp = this.now().toISOString();
    const history = [...current.statusHistory, {
      id: crypto.randomUUID(),
      from: current.status,
      to: target,
      changedAt: timestamp,
      reason,
    }].slice(-100);
    return {
      ...current,
      status: target,
      updatedAt: timestamp,
      completedAt: target === "completed" ? timestamp : target === "new" ? null : current.completedAt,
      rejectedAt: target === "rejected" ? timestamp : target === "new" ? null : current.rejectedAt,
      recurrenceEligible: current.complexity === "simple" && !["completed", "rejected"].includes(target),
      statusHistory: history,
    };
  }

  async postponeIdea(id: string, returnDate: string | null): Promise<Idea> {
    const current = (await this.getIdea(id)).idea;
    if (!ALLOWED_STATUS_TRANSITIONS[current.status].includes("postponed")) {
      throw new UserInputError("Эту идею сейчас нельзя отложить.");
    }
    const today = toLocalCalendarDate(this.now());
    if (returnDate !== null && compareCalendarDates(returnDate, today) < 0) {
      throw new UserInputError("Новая дата возвращения не может быть в прошлом.", "postponeDate");
    }
    const transitioned = this.buildTransition(current, "postponed", "manual");
    return this.database.saveIdeaBundle({
      ...transitioned,
      returnDate,
      returnMode: returnDate ? "date" : null,
      returnWeeks: null,
    }, undefined);
  }

  async repeatInFourWeeks(id: string): Promise<Idea> {
    const current = (await this.getIdea(id)).idea;
    const today = toLocalCalendarDate(this.now());
    if (current.complexity !== "simple" || ["completed", "rejected"].includes(current.status) ||
      !current.returnDate || compareCalendarDates(current.returnDate, today) > 0) {
      throw new UserInputError("Повтор через четыре недели доступен только для наступившей простой идеи.");
    }
    if (!ALLOWED_STATUS_TRANSITIONS[current.status].includes("postponed")) {
      throw new UserInputError("Эту идею сейчас нельзя отложить.");
    }
    const transitioned = this.buildTransition(current, "postponed", "manual");
    return this.database.saveIdeaBundle({
      ...transitioned,
      returnDate: addCalendarDays(today, 28),
      returnMode: "date",
      returnWeeks: null,
    }, undefined);
  }

  async restoreIdea(id: string): Promise<Idea> {
    return this.transitionIdea(id, "new", "restore");
  }

  async refreshDueIdeas(): Promise<number> {
    const today = toLocalCalendarDate(this.now());
    const due = (await this.listIdeas()).filter((idea) =>
      idea.status === "postponed" && idea.returnDate !== null && compareCalendarDates(idea.returnDate, today) <= 0,
    );
    for (const idea of due) await this.transitionIdea(idea.id, "review", "date");
    return due.length;
  }

  async saveDraft(formId: "draft_new" | `draft_edit_${string}`, input: Partial<Idea>, image: DraftImage | null): Promise<void> {
    const profileId = this.requireProfileId();
    const record: DraftRecord = {
      id: `${profileId}:${formId}`,
      profileId,
      formId,
      data: input,
      image,
      updatedAt: this.now().toISOString(),
    };
    await this.database.saveDraft(record);
  }

  async getDraft(formId: "draft_new" | `draft_edit_${string}`): Promise<DraftRecord | null> {
    const profileId = this.requireProfileId();
    return this.database.getDraft(`${profileId}:${formId}`);
  }

  async deleteDraft(formId: "draft_new" | `draft_edit_${string}`): Promise<void> {
    const profileId = this.requireProfileId();
    await this.database.deleteDraft(`${profileId}:${formId}`);
  }

  async makeLinkedPrefill(ideaId: string, subtaskId: string): Promise<{ input: IdeaInput; source: LinkedSource }> {
    const { idea } = await this.getIdea(ideaId);
    const subtask = findSubtask(idea, subtaskId);
    if (!subtask) throw new UserInputError("Подзадача не найдена.");
    if (subtask.linkedIdeaId) throw new UserInputError("Для подзадачи уже создана отдельная идея.");
    return {
      input: {
        ...createEmptyIdeaInput(idea.categoryId),
        title: subtask.title,
        description: subtask.description || subtask.title,
        priority: idea.priority,
      },
      source: { ideaId, subtaskId },
    };
  }

  private buildIdea(input: IdeaInput, profileId: string, current?: Idea): Idea {
    const now = this.now();
    const timestamp = now.toISOString();
    const title = assertLength(input.title, 1, 120, "Название должно содержать от 1 до 120 символов.", "title");
    const description = assertLength(input.description, 1, 1000, "Краткое описание должно содержать от 1 до 1000 символов.", "description");
    const notes = validateOptionalLength(input.notes, 5000, "Заметки не должны превышать 5000 символов.", "notes");
    if (!input.categoryId) throw new UserInputError("Выберите категорию.", "categoryId");
    if (!(["low", "medium", "high"] as string[]).includes(input.priority)) {
      throw new UserInputError("Выберите приоритет.", "priority");
    }
    if (!(["simple", "complex"] as string[]).includes(input.complexity)) {
      throw new UserInputError("Выберите сложность.", "complexity");
    }

    let returnDate: string | null = null;
    let returnWeeks: number | null = null;
    if (input.returnMode === "date") {
      if (!input.returnDate) throw new UserInputError("Выберите дату возвращения.", "returnDate");
      if (!current && compareCalendarDates(input.returnDate, toLocalCalendarDate(now)) < 0) {
        throw new UserInputError("При создании дата возвращения не может быть в прошлом.", "returnDate");
      }
      returnDate = input.returnDate;
    } else if (input.returnMode === "weeks") {
      if (!Number.isInteger(input.returnWeeks) || (input.returnWeeks ?? 0) < 1 || (input.returnWeeks ?? 0) > 520) {
        throw new UserInputError("Количество недель должно быть целым числом от 1 до 520.", "returnWeeks");
      }
      returnWeeks = input.returnWeeks;
      returnDate = addCalendarDays(toLocalCalendarDate(now), returnWeeks! * 7);
    } else if (input.returnMode !== null) {
      throw new UserInputError("Выберите способ даты возвращения.", "returnMode");
    }

    return {
      id: current?.id ?? crypto.randomUUID(),
      profileId,
      title,
      description,
      notes,
      categoryId: input.categoryId,
      priority: input.priority,
      complexity: input.complexity,
      status: current?.status ?? "new",
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: current?.updatedAt ?? timestamp,
      returnDate,
      returnMode: input.returnMode,
      returnWeeks,
      recurrenceEligible: input.complexity === "simple" && !["completed", "rejected"].includes(current?.status ?? "new"),
      completedAt: current?.completedAt ?? null,
      rejectedAt: current?.rejectedAt ?? null,
      hasImage: input.image === undefined ? (current?.hasImage ?? false) : input.image !== null,
      complexDetails: normalizeComplexDetails(input.complexDetails),
      subtasks: normalizeSubtasks(input.subtasks),
      sourceIdeaId: current?.sourceIdeaId ?? null,
      sourceSubtaskId: current?.sourceSubtaskId ?? null,
      sourceWasDeleted: current?.sourceWasDeleted ?? false,
      statusHistory: current?.statusHistory ?? [],
    };
  }

  private requireProfileId(): string {
    const id = this.activeProfileId();
    if (!id) throw new UserInputError("Сначала войдите в профиль.");
    return id;
  }
}
