import { LIMITS } from "../domain/constants";
import { isCalendarDate } from "../domain/dates";
import type { Category, DiagnosticRecord, Idea, ImageRecord, Profile } from "../domain/types";
import { StorageError } from "./errors";

const STATUS_VALUES = new Set(["new", "postponed", "review", "inProgress", "completed", "rejected"]);

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StorageError("CORRUPTED_DATA", `Повреждено поле «${label}».`, "validate");
  }
}

export function validateProfile(value: unknown): asserts value is Profile {
  if (!value || typeof value !== "object") {
    throw new StorageError("CORRUPTED_DATA", "Повреждён профиль.", "validateProfile");
  }
  const profile = value as Partial<Profile>;
  requireText(profile.id, "id профиля");
  requireText(profile.name, "имя профиля");
  requireText(profile.nameNormalized, "нормализованное имя");
  requireText(profile.pinHash, "хеш PIN");
  requireText(profile.pinSalt, "соль PIN");
}

export function validateCategory(value: unknown): asserts value is Category {
  if (!value || typeof value !== "object") {
    throw new StorageError("CORRUPTED_DATA", "Повреждена категория.", "validateCategory");
  }
  const category = value as Partial<Category>;
  requireText(category.id, "id категории");
  requireText(category.profileId, "id профиля категории");
  requireText(category.name, "название категории");
}

export function validateIdea(value: unknown): asserts value is Idea {
  if (!value || typeof value !== "object") {
    throw new StorageError("CORRUPTED_DATA", "Повреждена идея.", "validateIdea");
  }
  const idea = value as Partial<Idea>;
  requireText(idea.id, "id идеи");
  requireText(idea.profileId, "id профиля идеи");
  requireText(idea.title, "название идеи");
  requireText(idea.description, "описание идеи");
  requireText(idea.categoryId, "категория идеи");
  if (!STATUS_VALUES.has(String(idea.status))) {
    throw new StorageError("CORRUPTED_DATA", "Повреждён статус идеи.", "validateIdea");
  }
  if (idea.returnDate !== null && (typeof idea.returnDate !== "string" || !isCalendarDate(idea.returnDate))) {
    throw new StorageError("CORRUPTED_DATA", "Повреждена дата возвращения.", "validateIdea");
  }
  if (!Array.isArray(idea.subtasks) || !Array.isArray(idea.statusHistory)) {
    throw new StorageError("CORRUPTED_DATA", "Повреждена структура идеи.", "validateIdea");
  }
  enforceIdeaLimits(idea as Idea);
}

export function enforceIdeaLimits(idea: Idea): void {
  if (idea.subtasks.length > LIMITS.firstLevelSubtasksPerIdea) {
    throw limitError("Достигнут лимит подзадач первого уровня.");
  }
  for (const subtask of idea.subtasks) {
    if (subtask.children.length > LIMITS.nestedSubtasksPerSubtask) {
      throw limitError("Достигнут лимит вложенных подзадач.");
    }
  }
  const leafCount = idea.subtasks.reduce(
    (total, subtask) => total + (subtask.children.length || 1),
    0,
  );
  if (leafCount > LIMITS.leafSubtasksPerIdea) {
    throw limitError("Достигнут общий лимит конечных пунктов идеи.");
  }
  if (idea.statusHistory.length > LIMITS.statusHistoryPerIdea) {
    throw limitError("История статусов превышает допустимый размер.");
  }
}

export function trimStatusHistory(idea: Idea): Idea {
  if (idea.statusHistory.length <= LIMITS.statusHistoryPerIdea) return idea;
  return {
    ...idea,
    statusHistory: idea.statusHistory.slice(-LIMITS.statusHistoryPerIdea),
  };
}

export function validateImage(value: ImageRecord): void {
  requireText(value.ideaId, "id идеи изображения");
  requireText(value.profileId, "id профиля изображения");
  if (!(value.blob instanceof Blob) || value.blob.size > LIMITS.imageBytesPerIdea) {
    throw limitError("Изображение должно занимать не более 1 МБ.");
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(value.mimeType)) {
    throw new StorageError("VALIDATION_FAILED", "Формат изображения не поддерживается.", "validateImage");
  }
}

export function sanitizeDiagnostic(value: DiagnosticRecord): DiagnosticRecord {
  const scrub = (input: string, maxLength: number): string =>
    input
      .replace(/https?:\/\/\S+/gi, "[ссылка скрыта]")
      .replace(/\b\d{4}\b/g, "[PIN скрыт]")
      .replace(/[\r\n]+/g, " ")
      .slice(0, maxLength);

  return {
    occurredAt: value.occurredAt,
    appVersion: scrub(value.appVersion, 40),
    browserType: scrub(value.browserType, 80),
    errorCode: scrub(value.errorCode, 60),
    operation: scrub(value.operation, 80),
    message: scrub(value.message, 240),
  };
}

export function limitError(message: string): StorageError {
  return new StorageError("LIMIT_REACHED", message, "validateLimits");
}
