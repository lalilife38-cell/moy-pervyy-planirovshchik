import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/domain/constants";
import type { NestedSubtask, StatusHistoryEntry, Subtask } from "../src/domain/types";
import { StorageError } from "../src/storage/errors";
import { enforceIdeaLimits, sanitizeDiagnostic, trimStatusHistory, validateImage } from "../src/storage/validation";
import { makeIdea } from "./fixtures";

const nested = (id: string): NestedSubtask => ({
  id,
  title: id,
  description: "",
  completed: false,
  createdAt: "2026-08-17T10:00:00.000Z",
  completedAt: null,
  linkedIdeaId: null,
});

const firstLevel = (id: string, children: NestedSubtask[] = []): Subtask => ({
  ...nested(id),
  children,
});

describe("ограничения данных", () => {
  it("принимает разрешённые два уровня подзадач", () => {
    const idea = makeIdea();
    idea.subtasks = [firstLevel("a", [nested("b")])];
    expect(() => enforceIdeaLimits(idea)).not.toThrow();
  });

  it("блокирует превышение первого и вложенного уровней", () => {
    const idea = makeIdea();
    idea.subtasks = Array.from({ length: LIMITS.firstLevelSubtasksPerIdea + 1 }, (_, index) => firstLevel(String(index)));
    expect(() => enforceIdeaLimits(idea)).toThrow(StorageError);

    idea.subtasks = [
      firstLevel("root", Array.from({ length: LIMITS.nestedSubtasksPerSubtask + 1 }, (_, index) => nested(String(index)))),
    ];
    expect(() => enforceIdeaLimits(idea)).toThrow(StorageError);
  });

  it("блокирует более 500 конечных пунктов", () => {
    const idea = makeIdea();
    idea.subtasks = Array.from({ length: 26 }, (_, parentIndex) =>
      firstLevel(
        `root-${parentIndex}`,
        Array.from({ length: 20 }, (_, childIndex) => nested(`${parentIndex}-${childIndex}`)),
      ),
    );
    expect(() => enforceIdeaLimits(idea)).toThrow(StorageError);
  });

  it("оставляет только 100 последних переходов статуса", () => {
    const idea = makeIdea();
    idea.statusHistory = Array.from({ length: 105 }, (_, index): StatusHistoryEntry => ({
      id: String(index),
      from: "new",
      to: "inProgress",
      changedAt: new Date(index).toISOString(),
      reason: "manual",
    }));
    const trimmed = trimStatusHistory(idea);
    expect(trimmed.statusHistory).toHaveLength(100);
    expect(trimmed.statusHistory[0]?.id).toBe("5");
  });

  it("проверяет формат и размер изображения", () => {
    const valid = {
      ideaId: "idea-1",
      profileId: "profile-1",
      blob: new Blob([new Uint8Array(100)], { type: "image/jpeg" }),
      mimeType: "image/jpeg" as const,
      width: 10,
      height: 10,
      savedAt: new Date().toISOString(),
    };
    expect(() => validateImage(valid)).not.toThrow();
    expect(() => validateImage({ ...valid, blob: new Blob([new Uint8Array(LIMITS.imageBytesPerIdea + 1)]) })).toThrow(StorageError);
  });

  it("обезличивает PIN, ссылки и многострочный текст диагностики", () => {
    const safe = sanitizeDiagnostic({
      occurredAt: new Date().toISOString(),
      appVersion: "0.1.0",
      browserType: "Browser",
      errorCode: "FAIL",
      operation: "import",
      message: "PIN 1234\nhttps://example.test/private",
    });
    expect(safe.message).toBe("PIN [PIN скрыт] [ссылка скрыта]");
  });
});
