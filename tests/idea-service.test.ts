import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdeaService, createEmptyIdeaInput, subtaskProgress, type IdeaInput } from "../src/application/idea-service";
import { DATABASE_NAME } from "../src/domain/constants";
import type { NestedSubtask, Subtask } from "../src/domain/types";
import { IdeaDatabase } from "../src/storage/database";
import { makeCategory, makeIdea, makeProfile } from "./fixtures";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const child = (id: string, completed = false): NestedSubtask => ({
  id,
  title: `Шаг ${id}`,
  description: "",
  completed,
  createdAt: "2026-08-18T10:00:00.000Z",
  completedAt: completed ? "2026-08-18T11:00:00.000Z" : null,
  linkedIdeaId: null,
});

const parent = (id: string, children: NestedSubtask[] = [], completed = false): Subtask => ({
  ...child(id, completed),
  children,
});

function validInput(): IdeaInput {
  return {
    ...createEmptyIdeaInput("category-1"),
    title: "Новая идея",
    description: "Короткое описание",
  };
}

describe("полный жизненный цикл идеи", () => {
  let database: IdeaDatabase;
  let service: IdeaService;
  let now: Date;

  beforeEach(async () => {
    await deleteDatabase();
    database = await IdeaDatabase.open();
    await database.saveProfile(makeProfile());
    await database.saveCategory(makeCategory());
    now = new Date(2026, 7, 18, 12);
    service = new IdeaService(database, () => "profile-1", () => now);
  });

  afterEach(() => database.close());

  it("проверяет обязательные поля и количественные ограничения формы", async () => {
    await expect(service.createIdea({ ...validInput(), title: " " })).rejects.toMatchObject({ field: "title" });
    await expect(service.createIdea({ ...validInput(), description: " " })).rejects.toMatchObject({ field: "description" });
    await expect(service.createIdea({ ...validInput(), notes: "x".repeat(5001) })).rejects.toMatchObject({ field: "notes" });
    await expect(service.createIdea({ ...validInput(), title: "x".repeat(121) })).rejects.toMatchObject({ field: "title" });
  });

  it("назначает конкретную дату или N недель и запрещает прошлое при создании", async () => {
    await expect(service.createIdea({
      ...validInput(), returnMode: "date", returnDate: "2026-08-17",
    })).rejects.toMatchObject({ field: "returnDate" });
    await expect(service.createIdea({
      ...validInput(), returnMode: "weeks", returnWeeks: 0,
    })).rejects.toMatchObject({ field: "returnWeeks" });
    const idea = await service.createIdea({
      ...validInput(), returnMode: "weeks", returnWeeks: 3,
    });
    expect(idea.returnDate).toBe("2026-09-08");
    expect(idea.returnWeeks).toBe(3);
  });

  it("создаёт, читает и редактирует идею с корректным updatedAt", async () => {
    const created = await service.createIdea(validInput());
    expect((await service.getIdea(created.id)).idea.title).toBe("Новая идея");
    const unchanged = await service.updateIdea(created.id, { ...validInput(), image: undefined });
    expect(unchanged.updatedAt).toBe(created.updatedAt);
    now = new Date(2026, 7, 19, 12);
    const updated = await service.updateIdea(created.id, { ...validInput(), title: "Изменено", image: undefined });
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("сохраняет сложные данные и подзадачи при временном переключении на простую", async () => {
    const input = validInput();
    input.complexity = "complex";
    input.complexDetails.expectedResult = "Готовый результат";
    input.subtasks = [parent("one", [child("two")])];
    const created = await service.createIdea(input);
    const simple = await service.updateIdea(created.id, { ...input, complexity: "simple", image: undefined });
    expect(simple.complexDetails.expectedResult).toBe("Готовый результат");
    expect(simple.subtasks[0]?.children[0]?.id).toBe("two");
    const complexAgain = await service.updateIdea(created.id, { ...input, complexity: "complex", image: undefined });
    expect(complexAgain.subtasks).toHaveLength(1);
  });

  it("считает прогресс только по конечным пунктам", () => {
    const idea = makeIdea();
    idea.subtasks = [parent("one", [child("a", true), child("b")]), parent("two", [], true)];
    expect(subtaskProgress(idea)).toEqual({ completed: 2, total: 3 });
  });

  it("хранит черновик создания и черновики редактирования независимо", async () => {
    await service.saveDraft("draft_new", { title: "Новый черновик" }, null);
    await service.saveDraft("draft_edit_idea-1", { title: "Редактирование" }, null);
    expect((await service.getDraft("draft_new"))?.data.title).toBe("Новый черновик");
    expect((await service.getDraft("draft_edit_idea-1"))?.data.title).toBe("Редактирование");
    await service.deleteDraft("draft_new");
    expect(await service.getDraft("draft_edit_idea-1")).not.toBeNull();
  });

  it("создаёт из подзадачи связанную идею с двусторонними ссылками", async () => {
    const sourceInput = validInput();
    sourceInput.complexity = "complex";
    sourceInput.subtasks = [parent("source-subtask")];
    const source = await service.createIdea(sourceInput);
    const prefill = await service.makeLinkedPrefill(source.id, "source-subtask");
    expect(prefill.input.title).toBe("Шаг source-subtask");
    const linked = await service.createIdea({ ...prefill.input, description: "Отдельный шаг" }, prefill.source);
    expect(linked).toMatchObject({ sourceIdeaId: source.id, sourceSubtaskId: "source-subtask" });
    expect((await service.getIdea(source.id)).idea.subtasks[0]?.linkedIdeaId).toBe(linked.id);
  });

  it("очищает обратную ссылку при удалении подзадачи, не удаляя отдельную идею", async () => {
    const sourceInput = validInput();
    sourceInput.complexity = "complex";
    sourceInput.subtasks = [parent("source-subtask")];
    const source = await service.createIdea(sourceInput);
    const prefill = await service.makeLinkedPrefill(source.id, "source-subtask");
    const linked = await service.createIdea({ ...prefill.input, description: "Отдельный шаг" }, prefill.source);
    await service.updateIdea(source.id, { ...sourceInput, subtasks: [], image: undefined });
    const detached = (await service.getIdea(linked.id)).idea;
    expect(detached.sourceIdeaId).toBeNull();
    expect(await database.getIdea(linked.id)).not.toBeNull();
  });

  it("удаление отдельной идеи очищает ссылку подзадачи", async () => {
    const sourceInput = validInput();
    sourceInput.subtasks = [parent("source-subtask")];
    const source = await service.createIdea(sourceInput);
    const prefill = await service.makeLinkedPrefill(source.id, "source-subtask");
    const linked = await service.createIdea({ ...prefill.input, description: "Отдельный шаг" }, prefill.source);
    await service.deleteIdea(linked.id);
    expect((await service.getIdea(source.id)).idea.subtasks[0]?.linkedIdeaId).toBeNull();
  });

  it("удаление исходной идеи сохраняет отдельную и ставит пометку об удалённом источнике", async () => {
    const sourceInput = validInput();
    sourceInput.subtasks = [parent("source-subtask")];
    const source = await service.createIdea(sourceInput);
    const prefill = await service.makeLinkedPrefill(source.id, "source-subtask");
    const linked = await service.createIdea({ ...prefill.input, description: "Отдельный шаг" }, prefill.source);
    await service.deleteIdea(source.id);
    const orphan = (await service.getIdea(linked.id)).idea;
    expect(orphan.sourceIdeaId).toBeNull();
    expect(orphan.sourceWasDeleted).toBe(true);
  });

  it("сохраняет, заменяет и удаляет изображение вместе с идеей", async () => {
    const firstImage = {
      blob: new Blob(["one"], { type: "image/jpeg" }),
      mimeType: "image/jpeg" as const,
      width: 10,
      height: 10,
      savedAt: now.toISOString(),
    };
    const created = await service.createIdea({ ...validInput(), image: firstImage });
    expect((await service.getIdea(created.id)).image?.blob.size).toBe(3);
    const secondImage = { ...firstImage, blob: new Blob(["replacement"], { type: "image/jpeg" }) };
    await service.updateIdea(created.id, { ...validInput(), image: secondImage });
    expect((await service.getIdea(created.id)).image?.blob.size).toBe(11);
    await service.updateIdea(created.id, { ...validInput(), image: null });
    expect((await service.getIdea(created.id)).image).toBeNull();
  });
});
