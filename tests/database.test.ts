import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATABASE_NAME, LIMITS, SCHEMA_VERSION } from "../src/domain/constants";
import type { ImageRecord } from "../src/domain/types";
import { IdeaDatabase } from "../src/storage/database";
import { StorageError } from "../src/storage/errors";
import { makeCategory, makeIdea, makeProfile } from "./fixtures";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function createVersionOneDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const raw = request.result;
      const profiles = raw.createObjectStore("profiles", { keyPath: "id" });
      profiles.createIndex("nameNormalized", "nameNormalized", { unique: true });
      const categories = raw.createObjectStore("categories", { keyPath: "id" });
      categories.createIndex("profileId", "profileId");
      categories.createIndex("profileAndName", ["profileId", "nameNormalized"], { unique: true });
      const ideas = raw.createObjectStore("ideas", { keyPath: "id" });
      ideas.createIndex("profileId", "profileId");
      ideas.createIndex("profileAndStatus", ["profileId", "status"]);
      ideas.createIndex("profileAndReturnDate", ["profileId", "returnDate"]);
      const images = raw.createObjectStore("images", { keyPath: "ideaId" });
      images.createIndex("profileId", "profileId");
      const drafts = raw.createObjectStore("drafts", { keyPath: "id" });
      drafts.createIndex("profileId", "profileId");
      const diagnostics = raw.createObjectStore("diagnostics", { keyPath: "id", autoIncrement: true });
      diagnostics.createIndex("occurredAt", "occurredAt");
      raw.createObjectStore("meta", { keyPath: "key" });
      profiles.add(makeProfile());
      categories.add(makeCategory());
      ideas.add(makeIdea());
      request.transaction?.objectStore("meta").add({
        key: "database",
        schemaVersion: 1,
        updatedAt: "2026-08-17T10:00:00.000Z",
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe("слой IndexedDB", () => {
  let database: IdeaDatabase;

  beforeEach(async () => {
    await deleteDatabase();
    database = await IdeaDatabase.open();
  });

  afterEach(() => database.close());

  it("создаёт версионированную схему и все хранилища", async () => {
    expect(await database.getMetadata()).toMatchObject({ schemaVersion: SCHEMA_VERSION });
    database.close();
    const request = indexedDB.open(DATABASE_NAME);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(Array.from(raw.objectStoreNames)).toEqual([
      "categories", "diagnostics", "drafts", "ideas", "images", "meta", "profiles",
    ]);
    raw.close();
    database = await IdeaDatabase.open();
  });

  it("мигрирует схему версии 1 без потери идей и добавляет индекс категорий", async () => {
    database.close();
    await deleteDatabase();
    await createVersionOneDatabase();
    database = await IdeaDatabase.open();
    expect((await database.getMetadata()).schemaVersion).toBe(SCHEMA_VERSION);
    expect((await database.getIdea("idea-1"))?.title).toBe("Тестовая идея");
    expect(await database.countIdeasByCategory("profile-1", "category-1")).toBe(1);
  });

  it("сохраняет связанные сущности и читает их после повторного открытия", async () => {
    const profile = makeProfile();
    const category = makeCategory();
    const idea = makeIdea();
    await database.saveProfile(profile);
    await database.saveCategory(category);
    await database.saveIdea(idea);
    await database.saveDraft({
      id: "profile-1:draft_new",
      profileId: "profile-1",
      formId: "draft_new",
      data: { title: "Черновик" },
      image: null,
      updatedAt: new Date().toISOString(),
    });

    const image: ImageRecord = {
      ideaId: idea.id,
      profileId: profile.id,
      blob: new Blob(["photo"], { type: "image/webp" }),
      mimeType: "image/webp",
      width: 20,
      height: 20,
      savedAt: new Date().toISOString(),
    };
    await database.saveImage(image);
    database.close();
    database = await IdeaDatabase.open();

    expect((await database.getProfile(profile.id))?.name).toBe(profile.name);
    expect(await database.listCategories(profile.id)).toHaveLength(1);
    expect((await database.getIdea(idea.id))?.title).toBe(idea.title);
    expect((await database.getImage(idea.id))?.blob.size).toBe(5);
    expect(await database.listDrafts(profile.id)).toHaveLength(1);
  });

  it("блокирует ссылки на отсутствующий или чужой профиль", async () => {
    await database.saveProfile(makeProfile());
    await expect(database.saveCategory(makeCategory("missing"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await database.saveCategory(makeCategory());
    await expect(database.saveIdea({ ...makeIdea("other"), categoryId: "category-1" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("атомарно удаляет только данные выбранного профиля", async () => {
    for (const id of ["profile-1", "profile-2"]) {
      await database.saveProfile(makeProfile(id));
      await database.saveCategory(makeCategory(id, `category-${id}`));
      await database.saveIdea({ ...makeIdea(id, `idea-${id}`), categoryId: `category-${id}` });
    }
    await database.deleteProfileData("profile-1");
    expect(await database.getProfile("profile-1")).toBeNull();
    expect(await database.listIdeas("profile-1")).toEqual([]);
    expect(await database.getProfile("profile-2")).not.toBeNull();
    expect(await database.listIdeas("profile-2")).toHaveLength(1);
  });

  it("обрезает журнал до 50 записей и не раскрывает PIN или URL", async () => {
    for (let index = 0; index < LIMITS.diagnostics + 5; index += 1) {
      await database.appendDiagnostic({
        occurredAt: new Date(index).toISOString(),
        appVersion: "0.1.0",
        browserType: "test",
        errorCode: "TEST",
        operation: "test",
        message: `Ошибка ${index} PIN 1234 https://example.test/${index}`,
      });
    }
    const diagnostics = await database.listDiagnostics();
    expect(diagnostics).toHaveLength(LIMITS.diagnostics);
    expect(diagnostics[0]?.message).toContain("Ошибка 5");
    expect(JSON.stringify(diagnostics)).not.toContain("1234");
    expect(JSON.stringify(diagnostics)).not.toContain("https://");
  });

  it("не принимает повреждённую идею и сохраняет прежние данные", async () => {
    await database.saveProfile(makeProfile());
    await database.saveCategory(makeCategory());
    const valid = makeIdea();
    await database.saveIdea(valid);
    await expect(database.saveIdea({ ...valid, status: "broken" as never })).rejects.toBeInstanceOf(StorageError);
    expect((await database.getIdea(valid.id))?.status).toBe("new");
  });

  it("блокирует 101-ю пользовательскую категорию без потери сохранённых", async () => {
    await database.saveProfile(makeProfile());
    for (let index = 0; index < LIMITS.userCategoriesPerProfile; index += 1) {
      await database.saveCategory({
        ...makeCategory("profile-1", `user-category-${index}`),
        name: `Категория ${index}`,
        nameNormalized: `категория ${index}`,
        isSystem: false,
        systemKey: null,
      });
    }
    await expect(database.saveCategory({
      ...makeCategory("profile-1", "category-over-limit"),
      name: "Лишняя",
      nameNormalized: "лишняя",
      isSystem: false,
      systemKey: null,
    })).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    expect(await database.listCategories("profile-1")).toHaveLength(LIMITS.userCategoriesPerProfile);
  });

  it("блокирует 2001-ю идею без потери сохранённых", async () => {
    await database.saveProfile(makeProfile());
    await database.saveCategory(makeCategory());
    for (let index = 0; index < LIMITS.ideasPerProfile; index += 1) {
      await database.saveIdea(makeIdea("profile-1", `idea-${index}`));
    }
    await expect(database.saveIdea(makeIdea("profile-1", "idea-over-limit"))).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    expect(await database.listIdeas("profile-1")).toHaveLength(LIMITS.ideasPerProfile);
  }, 30_000);

  it("блокирует 26-е изображение без потери сохранённых", async () => {
    await database.saveProfile(makeProfile());
    await database.saveCategory(makeCategory());
    for (let index = 0; index <= LIMITS.ideasWithImagesPerProfile; index += 1) {
      await database.saveIdea(makeIdea("profile-1", `photo-idea-${index}`));
    }
    for (let index = 0; index < LIMITS.ideasWithImagesPerProfile; index += 1) {
      await database.saveImage({
        ideaId: `photo-idea-${index}`,
        profileId: "profile-1",
        blob: new Blob([String(index)], { type: "image/jpeg" }),
        mimeType: "image/jpeg",
        width: 10,
        height: 10,
        savedAt: new Date().toISOString(),
      });
    }
    await expect(database.saveImage({
      ideaId: `photo-idea-${LIMITS.ideasWithImagesPerProfile}`,
      profileId: "profile-1",
      blob: new Blob(["extra"], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 10,
      height: 10,
      savedAt: new Date().toISOString(),
    })).rejects.toMatchObject({ code: "LIMIT_REACHED" });
    expect((await database.getImage("photo-idea-0"))?.blob.size).toBeGreaterThan(0);
  });
});
