import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "../src/application/backup-service";
import { hashPin } from "../src/auth/pin";
import { DATABASE_NAME } from "../src/domain/constants";
import type { DraftRecord, ProfileBundle } from "../src/domain/types";
import { IdeaDatabase } from "../src/storage/database";
import { makeCategory, makeIdea, makeProfile } from "./fixtures";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("резервные копии профиля", () => {
  let database: IdeaDatabase;
  let service: BackupService;

  beforeEach(async () => {
    await deleteDatabase();
    database = await IdeaDatabase.open();
    const credentials = await hashPin("1234");
    await database.saveProfile({ ...makeProfile(), ...credentials, name: "Анна", nameNormalized: "анна" });
    await database.saveCategory(makeCategory());
    const source = makeIdea("profile-1", "source");
    source.title = "<b>Исходная</b>";
    source.subtasks = [{
      id: "task-1", title: "Шаг", description: "", completed: false, createdAt: source.createdAt,
      completedAt: null, linkedIdeaId: "linked", children: [],
    }];
    const linked = { ...makeIdea("profile-1", "linked"), sourceIdeaId: "source", sourceSubtaskId: "task-1", status: "completed" as const, completedAt: source.createdAt };
    await database.saveIdea(source);
    await database.saveIdea(linked);
    await database.saveImage({ ideaId: "source", profileId: "profile-1", blob: new Blob(["photo"], { type: "image/jpeg" }), mimeType: "image/jpeg", width: 10, height: 10, savedAt: source.createdAt });
    const draft: DraftRecord = { id: "profile-1:draft_new", profileId: "profile-1", formId: "draft_new", data: { title: "Черновик", categoryId: "category-1" }, image: { blob: new Blob(["draft"], { type: "image/jpeg" }), mimeType: "image/jpeg", width: 5, height: 5, savedAt: source.createdAt }, updatedAt: source.createdAt };
    await database.saveDraft(draft);
    service = new BackupService(database, () => "profile-1", () => new Date(2026, 7, 18, 12));
  });

  afterEach(() => database.close());

  it("экспортирует профиль, архив, связи, черновик и фото без PIN-хеша", async () => {
    const result = await service.exportCurrentProfile(true);
    expect(result.filename).toBe("vremya-idei_анна_2026-08-18.json");
    expect(result.text).not.toContain("pinHash");
    expect(result.text).not.toContain("pinSalt");
    expect(result.envelope.ideas).toHaveLength(2);
    expect(result.envelope.images[0]?.base64).toBeTruthy();
    expect(result.envelope.drafts[0]?.image?.base64).toBeTruthy();
  });

  it("импортирует независимый профиль с новыми ID и целыми двусторонними ссылками", async () => {
    const exported = await service.exportCurrentProfile(true);
    const result = await service.importBackup(exported.envelope, { name: "Анна — копия", pin: "9999", pinConfirmation: "9999" });
    const bundle = await database.getProfileBundle(result.profileId);
    expect(bundle.profile.pinHash).not.toBe((await database.getProfile("profile-1"))?.pinHash);
    expect(bundle.ideas).toHaveLength(2);
    const importedSource = bundle.ideas.find((idea) => idea.title === "Исходная")!;
    const importedLinked = bundle.ideas.find((idea) => idea.status === "completed")!;
    expect(importedSource.id).not.toBe("source");
    expect(importedSource.subtasks[0]?.linkedIdeaId).toBe(importedLinked.id);
    expect(importedLinked.sourceIdeaId).toBe(importedSource.id);
    expect(importedLinked.sourceSubtaskId).toBe(importedSource.subtasks[0]?.id);
    expect(bundle.images[0]?.blob.size).toBe(5);
    expect(bundle.drafts[0]?.image?.blob.size).toBe(5);
  });

  it("экспортирует без фото с явным отчётом", async () => {
    const result = await service.exportCurrentProfile(false);
    expect(result.envelope.images).toEqual([]);
    expect(result.envelope.drafts[0]?.image).toBeNull();
    expect(result.envelope.report).toMatchObject({ photosIncluded: false, omittedImages: 2 });
  });

  it("обрабатывает конфликт имени только как копию или подтверждённую замену", async () => {
    const exported = await service.exportCurrentProfile(false);
    await expect(service.importBackup(exported.envelope, { name: "Анна", pin: "9999", pinConfirmation: "9999" })).rejects.toThrow("уже существует");
    await expect(service.importBackup(exported.envelope, { name: "Анна", pin: "9999", pinConfirmation: "9999", replace: { profileId: "profile-1", currentPin: "0000", confirmationWord: "УДАЛИТЬ" } })).rejects.toThrow("верный PIN");
    const replaced = await service.importBackup(exported.envelope, { name: "Анна", pin: "9999", pinConfirmation: "9999", replace: { profileId: "profile-1", currentPin: "1234", confirmationWord: "УДАЛИТЬ" } });
    expect(replaced.profileId).toBe("profile-1");
    expect((await database.listProfiles()).filter(({ name }) => name === "Анна")).toHaveLength(1);
  });

  it("отклоняет неизвестную схему, повреждённый JSON и файл свыше 50 МБ", () => {
    expect(() => service.parseBackup("not json")).toThrow("JSON");
    expect(() => service.parseBackup(JSON.stringify({ schemaVersion: 99, app: "Время идеи" }))).toThrow("не поддерживается");
    expect(() => service.parseBackup("{}", 50 * 1024 * 1024 + 1)).toThrow("50 МБ");
  });

  it("отменяет экспорт без изменения данных", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(service.exportCurrentProfile(true, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await database.listIdeas("profile-1")).toHaveLength(2);
  });

  it("проверяет квоту до атомарного импорта", async () => {
    const exported = await service.exportCurrentProfile(true);
    vi.spyOn(database, "estimateStorage").mockResolvedValue({ usage: 100, quota: 101, persistent: false });
    await expect(service.importBackup(exported.envelope, { name: "Нет места", pin: "9999", pinConfirmation: "9999" })).rejects.toThrow("Недостаточно места");
    expect(await database.findProfileByNormalizedName("нет места")).toBeNull();
  });

  it("оценивает предупреждение 20 МБ и блокировку 40 МБ", async () => {
    const original = await database.getProfileBundle("profile-1");
    const oneMb = new Blob([new Uint8Array(1024 * 1024)], { type: "image/jpeg" });
    const draft = original.drafts[0]!;
    const fakeBundle = (count: number): ProfileBundle => ({ ...original, drafts: Array.from({ length: count }, (_, index) => ({ ...draft, id: `profile-1:draft_edit_fake-${index}`, formId: `draft_edit_fake-${index}` as const, image: { ...draft.image!, blob: oneMb } })) });
    const getBundle = vi.spyOn(database, "getProfileBundle");
    getBundle.mockResolvedValue(fakeBundle(16));
    expect(await service.estimateCurrentExport()).toMatchObject({ requiresWarning: true, exceedsMaximumWithPhotos: false });
    getBundle.mockResolvedValue(fakeBundle(31));
    await expect(service.exportCurrentProfile(true)).rejects.toThrow("40 МБ");
  });
});
