import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_STATUS_TRANSITIONS, IdeaService } from "../src/application/idea-service";
import { DATABASE_NAME } from "../src/domain/constants";
import type { Idea, IdeaStatus } from "../src/domain/types";
import { IdeaDatabase } from "../src/storage/database";
import { makeCategory, makeIdea, makeProfile } from "./fixtures";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("статусы, архив и повтор", () => {
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

  async function save(status: IdeaStatus = "new", patch: Partial<Idea> = {}): Promise<Idea> {
    const value = { ...makeIdea(), status, ...patch };
    await database.saveIdea(value);
    return value;
  }

  it("содержит точную матрицу разрешённых переходов", () => {
    expect(ALLOWED_STATUS_TRANSITIONS).toEqual({
      new: ["postponed", "inProgress", "completed", "rejected"],
      postponed: ["review", "inProgress", "completed", "rejected"],
      review: ["inProgress", "postponed", "completed", "rejected"],
      inProgress: ["postponed", "completed", "rejected"],
      completed: ["new"],
      rejected: ["new"],
    });
  });

  it("разрешает только матрицу переходов и записывает ручную причину", async () => {
    await save("new");
    await expect(service.transitionIdea("idea-1", "review")).rejects.toThrow("недоступен");
    const working = await service.transitionIdea("idea-1", "inProgress");
    expect(working.status).toBe("inProgress");
    expect(working.statusHistory.at(-1)).toMatchObject({ from: "new", to: "inProgress", reason: "manual" });
    await expect(service.transitionIdea("idea-1", "new")).rejects.toThrow("недоступен");
    await database.saveIdea({ ...working, status: "postponed" });
    await expect(service.transitionIdea("idea-1", "review", "manual")).rejects.toThrow("автоматически");
  });

  it("автоматически переводит только наступившие отложенные идеи", async () => {
    await save("postponed", { id: "due", returnDate: "2026-08-18" });
    await save("postponed", { id: "future", returnDate: "2026-08-19" });
    await save("new", { id: "new-due", returnDate: "2026-08-17" });
    expect(await service.refreshDueIdeas()).toBe(1);
    expect((await database.getIdea("due"))?.status).toBe("review");
    expect((await database.getIdea("due"))?.statusHistory.at(-1)?.reason).toBe("date");
    expect((await database.getIdea("future"))?.status).toBe("postponed");
    expect((await database.getIdea("new-due"))?.status).toBe("new");
  });

  it("откладывает с датой или без неё и запрещает прошлую дату", async () => {
    await save("review");
    await expect(service.postponeIdea("idea-1", "2026-08-17")).rejects.toMatchObject({ field: "postponeDate" });
    const dated = await service.postponeIdea("idea-1", "2026-09-01");
    expect(dated).toMatchObject({ status: "postponed", returnDate: "2026-09-01", returnMode: "date" });
    await database.saveIdea({ ...dated, status: "review" });
    const withoutDate = await service.postponeIdea("idea-1", null);
    expect(withoutDate).toMatchObject({ status: "postponed", returnDate: null, returnMode: null });
  });

  it("повторяет наступившую простую идею только вручную и ровно через 28 дней", async () => {
    await save("review", { returnDate: "2026-08-17", complexity: "simple" });
    expect((await database.getIdea("idea-1"))?.returnDate).toBe("2026-08-17");
    const repeated = await service.repeatInFourWeeks("idea-1");
    expect(repeated).toMatchObject({ status: "postponed", returnDate: "2026-09-15" });
    await database.saveIdea({ ...repeated, status: "review", complexity: "complex", returnDate: "2026-08-18" });
    await expect(service.repeatInFourWeeks("idea-1")).rejects.toThrow("простой идеи");
  });

  it("заполняет даты архива и очищает их при восстановлении", async () => {
    await save("inProgress");
    const completed = await service.transitionIdea("idea-1", "completed");
    expect(completed.completedAt).toBe(now.toISOString());
    now = new Date(2026, 7, 19, 12);
    const restored = await service.restoreIdea("idea-1");
    expect(restored).toMatchObject({ status: "new", completedAt: null, rejectedAt: null });
    expect(restored.statusHistory.at(-1)?.reason).toBe("restore");
  });

  it("оставляет только 100 последних записей истории", async () => {
    const history = Array.from({ length: 100 }, (_, index) => ({
      id: `history-${index}`, from: "new" as const, to: "inProgress" as const,
      changedAt: `2026-08-17T10:${String(index % 60).padStart(2, "0")}:00.000Z`, reason: "manual" as const,
    }));
    await save("new", { statusHistory: history });
    const changed = await service.transitionIdea("idea-1", "inProgress");
    expect(changed.statusHistory).toHaveLength(100);
    expect(changed.statusHistory[0]?.id).toBe("history-1");
  });
});
