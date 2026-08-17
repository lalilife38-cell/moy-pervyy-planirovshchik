import { DATABASE_NAME, LIMITS, SCHEMA_VERSION } from "../domain/constants";
import type {
  Category,
  DatabaseMetadata,
  DiagnosticRecord,
  DraftRecord,
  DraftImage,
  Idea,
  ImageRecord,
  Profile,
  ProfileBundle,
  StorageEstimate,
} from "../domain/types";
import { StorageError, normalizeStorageError } from "./errors";
import {
  limitError,
  sanitizeDiagnostic,
  trimStatusHistory,
  validateCategory,
  validateIdea,
  validateImage,
  validateProfile,
} from "./validation";

type StoreName =
  | "profiles"
  | "categories"
  | "ideas"
  | "images"
  | "drafts"
  | "diagnostics"
  | "meta";

const APP_VERSION = "0.1.0";

function findSubtask(idea: Idea, subtaskId: string) {
  for (const subtask of idea.subtasks) {
    if (subtask.id === subtaskId) return subtask;
    const child = subtask.children.find((item) => item.id === subtaskId);
    if (child) return child;
  }
  return null;
}

function linkedIdeaIds(idea: Idea): Set<string> {
  const ids = new Set<string>();
  for (const subtask of idea.subtasks) {
    if (subtask.linkedIdeaId) ids.add(subtask.linkedIdeaId);
    for (const child of subtask.children) if (child.linkedIdeaId) ids.add(child.linkedIdeaId);
  }
  return ids;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new DOMException("Транзакция отменена", "AbortError")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new DOMException("Ошибка транзакции", "UnknownError")),
      { once: true },
    );
  });
}

function migrateSchema(database: IDBDatabase, transaction: IDBTransaction): void {
  if (!database.objectStoreNames.contains("profiles")) {
    const profiles = database.createObjectStore("profiles", { keyPath: "id" });
    profiles.createIndex("nameNormalized", "nameNormalized", { unique: true });
  }

  if (!database.objectStoreNames.contains("categories")) {
    const categories = database.createObjectStore("categories", { keyPath: "id" });
    categories.createIndex("profileId", "profileId");
    categories.createIndex("profileAndName", ["profileId", "nameNormalized"], { unique: true });
  }

  if (!database.objectStoreNames.contains("ideas")) {
    const ideas = database.createObjectStore("ideas", { keyPath: "id" });
    ideas.createIndex("profileId", "profileId");
    ideas.createIndex("profileAndStatus", ["profileId", "status"]);
    ideas.createIndex("profileAndReturnDate", ["profileId", "returnDate"]);
  }

  const ideas = transaction.objectStore("ideas");
  if (!ideas.indexNames.contains("profileAndCategory")) {
    ideas.createIndex("profileAndCategory", ["profileId", "categoryId"]);
  }

  if (!database.objectStoreNames.contains("images")) {
    const images = database.createObjectStore("images", { keyPath: "ideaId" });
    images.createIndex("profileId", "profileId");
  }

  if (!database.objectStoreNames.contains("drafts")) {
    const drafts = database.createObjectStore("drafts", { keyPath: "id" });
    drafts.createIndex("profileId", "profileId");
  }

  if (!database.objectStoreNames.contains("diagnostics")) {
    const diagnostics = database.createObjectStore("diagnostics", {
      keyPath: "id",
      autoIncrement: true,
    });
    diagnostics.createIndex("occurredAt", "occurredAt");
  }

  if (!database.objectStoreNames.contains("meta")) {
    database.createObjectStore("meta", { keyPath: "key" });
  }

  const metadata: DatabaseMetadata = {
    key: "database",
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  transaction.objectStore("meta").put(metadata);
}

export class IdeaDatabase {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<IdeaDatabase> {
    if (!("indexedDB" in globalThis) || !globalThis.indexedDB) {
      throw new StorageError(
        "STORAGE_UNAVAILABLE",
        "IndexedDB недоступна.",
        "openDatabase",
      );
    }

    const request = globalThis.indexedDB.open(DATABASE_NAME, SCHEMA_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.transaction) return;
      migrateSchema(request.result, request.transaction);
    });

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener(
        "blocked",
        () => reject(new StorageError("TRANSACTION_FAILED", "Обновление базы заблокировано другой вкладкой.", "openDatabase")),
        { once: true },
      );
    }).catch((error: unknown) => {
      throw normalizeStorageError(error, "openDatabase");
    });

    const instance = new IdeaDatabase(database);
    database.addEventListener("versionchange", () => database.close());
    const metadata = await instance.getMetadata();
    if (metadata.schemaVersion > SCHEMA_VERSION) {
      database.close();
      throw new StorageError(
        "UNKNOWN_SCHEMA",
        "Обнаружена неизвестная новая версия данных.",
        "openDatabase",
      );
    }
    return instance;
  }

  close(): void {
    this.database.close();
  }

  async getMetadata(): Promise<DatabaseMetadata> {
    return this.readOne<DatabaseMetadata>("meta", "database", "readMetadata").then((value) => {
      if (!value || typeof value.schemaVersion !== "number") {
        throw new StorageError("CORRUPTED_DATA", "Метаданные базы повреждены.", "readMetadata");
      }
      return value;
    });
  }

  async saveProfile(profile: Profile): Promise<void> {
    validateProfile(profile);
    await this.writeOne("profiles", profile, "saveProfile");
  }

  async createProfileBundle(
    profile: Profile,
    categories: [Category, Category],
    demonstrationIdea: Idea,
  ): Promise<void> {
    validateProfile(profile);
    categories.forEach(validateCategory);
    validateIdea(demonstrationIdea);
    if (
      categories.some((category) => category.profileId !== profile.id || !category.isSystem) ||
      demonstrationIdea.profileId !== profile.id ||
      !categories.some((category) => category.id === demonstrationIdea.categoryId)
    ) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "Начальные данные профиля не согласованы.",
        "createProfileBundle",
      );
    }

    await this.withTransaction(
      ["profiles", "categories", "ideas"],
      "readwrite",
      "createProfileBundle",
      async (stores) => {
        await requestResult(stores.profiles.add(profile));
        for (const category of categories) await requestResult(stores.categories.add(category));
        await requestResult(stores.ideas.add(demonstrationIdea));
      },
    );
  }

  async findProfileByNormalizedName(nameNormalized: string): Promise<Profile | null> {
    return this.withTransaction(["profiles"], "readonly", "findProfileByName", async (stores) => {
      const profile = await requestResult<Profile | undefined>(
        stores.profiles.index("nameNormalized").get(nameNormalized),
      );
      if (profile) validateProfile(profile);
      return profile ?? null;
    });
  }

  async getProfile(id: string): Promise<Profile | null> {
    const profile = await this.readOne<Profile>("profiles", id, "getProfile");
    if (profile) validateProfile(profile);
    return profile;
  }

  async listProfiles(): Promise<Profile[]> {
    const profiles = await this.readAll<Profile>("profiles", "listProfiles");
    profiles.forEach(validateProfile);
    return profiles;
  }

  async saveCategory(category: Category): Promise<void> {
    validateCategory(category);
    await this.withTransaction(["profiles", "categories"], "readwrite", "saveCategory", async (stores) => {
      const profile = await requestResult<Profile | undefined>(stores.profiles.get(category.profileId));
      if (!profile) {
        throw new StorageError("VALIDATION_FAILED", "Профиль категории не найден.", "saveCategory");
      }
      const store = stores.categories;
      const existing = await requestResult<Category | undefined>(store.get(category.id));
      if (!existing && !category.isSystem) {
        const categories = await requestResult<Category[]>(store.index("profileId").getAll(category.profileId));
        if (categories.filter((item) => !item.isSystem).length >= LIMITS.userCategoriesPerProfile) {
          throw limitError("Достигнут лимит пользовательских категорий.");
        }
      }
      await requestResult(store.put(category));
    });
  }

  async listCategories(profileId: string): Promise<Category[]> {
    const categories = await this.readByIndex<Category>("categories", "profileId", profileId, "listCategories");
    categories.forEach(validateCategory);
    return categories;
  }

  async deleteCategoryIfUnused(profileId: string, id: string): Promise<void> {
    await this.withTransaction(
      ["categories", "ideas"],
      "readwrite",
      "deleteCategory",
      async (stores) => {
        const category = await requestResult<Category | undefined>(stores.categories.get(id));
        if (!category || category.profileId !== profileId) {
          throw new StorageError("VALIDATION_FAILED", "Категория не найдена.", "deleteCategory");
        }
        if (category.isSystem) {
          throw new StorageError(
            "VALIDATION_FAILED",
            "Начальную категорию нельзя удалить.",
            "deleteCategory",
          );
        }
        const ideasCount = await requestResult(
          stores.ideas.index("profileAndCategory").count([profileId, id]),
        );
        if (ideasCount > 0) {
          throw new StorageError(
            "VALIDATION_FAILED",
            `Категория используется в ${ideasCount} идеях.`,
            "deleteCategory",
          );
        }
        await requestResult(stores.categories.delete(id));
      },
    );
  }

  async countIdeasByCategory(profileId: string, categoryId: string): Promise<number> {
    return this.withTransaction(["ideas"], "readonly", "countIdeasByCategory", (stores) =>
      requestResult(stores.ideas.index("profileAndCategory").count([profileId, categoryId])),
    );
  }

  async saveIdea(input: Idea): Promise<void> {
    const idea = trimStatusHistory(input);
    validateIdea(idea);
    await this.withTransaction(["ideas", "categories"], "readwrite", "saveIdea", async (stores) => {
      const category = await requestResult<Category | undefined>(stores.categories.get(idea.categoryId));
      if (!category || category.profileId !== idea.profileId) {
        throw new StorageError("VALIDATION_FAILED", "Категория идеи не найдена в профиле.", "saveIdea");
      }
      const store = stores.ideas;
      const existing = await requestResult<Idea | undefined>(store.get(idea.id));
      if (!existing) {
        const count = await requestResult(store.index("profileId").count(idea.profileId));
        if (count >= LIMITS.ideasPerProfile) {
          throw limitError("Достигнут лимит идей профиля.");
        }
      }
      await requestResult(store.put(idea));
    });
  }

  async getIdea(id: string): Promise<Idea | null> {
    const idea = await this.readOne<Idea>("ideas", id, "getIdea");
    if (idea) validateIdea(idea);
    return idea;
  }

  async listIdeas(profileId: string): Promise<Idea[]> {
    const ideas = await this.readByIndex<Idea>("ideas", "profileId", profileId, "listIdeas");
    ideas.forEach(validateIdea);
    return ideas;
  }

  async deleteIdea(id: string): Promise<void> {
    const idea = await this.getIdea(id);
    if (!idea) return;
    await this.deleteIdeaConnected(idea.profileId, id);
  }

  async saveIdeaBundle(
    input: Idea,
    image: DraftImage | null | undefined,
    draftId?: string,
  ): Promise<Idea> {
    const idea = trimStatusHistory(input);
    validateIdea(idea);
    if (image) this.validateDraftImage(image);
    return this.withTransaction(
      ["ideas", "categories", "images", "drafts", "profiles"],
      "readwrite",
      "saveIdeaBundle",
      async (stores) => {
        const category = await requestResult<Category | undefined>(stores.categories.get(idea.categoryId));
        if (!category || category.profileId !== idea.profileId) {
          throw new StorageError("VALIDATION_FAILED", "Категория идеи не найдена в профиле.", "saveIdeaBundle");
        }
        const existing = await requestResult<Idea | undefined>(stores.ideas.get(idea.id));
        if (!existing) {
          const count = await requestResult(stores.ideas.index("profileId").count(idea.profileId));
          if (count >= LIMITS.ideasPerProfile) throw limitError("Достигнут лимит идей профиля.");
        }

        if (existing) {
          const removedLinks = [...linkedIdeaIds(existing)].filter((id) => !linkedIdeaIds(idea).has(id));
          for (const linkedId of removedLinks) {
            const linked = await requestResult<Idea | undefined>(stores.ideas.get(linkedId));
            if (linked?.sourceIdeaId === idea.id) {
              await requestResult(stores.ideas.put({
                ...linked,
                sourceIdeaId: null,
                sourceSubtaskId: null,
                sourceWasDeleted: false,
              }));
            }
          }
        }

        const saved: Idea = {
          ...idea,
          hasImage: image === undefined ? (existing?.hasImage ?? idea.hasImage) : image !== null,
        };
        await requestResult(stores.ideas.put(saved));
        const addedPhoto = image !== null && image !== undefined && !(await requestResult(stores.images.get(saved.id)));
        await this.writeImageInTransaction(stores.images, saved, image);
        if (addedPhoto) {
          const profile = await requestResult<Profile | undefined>(stores.profiles.get(saved.profileId));
          if (profile) await requestResult(stores.profiles.put({ ...profile, photosSinceExport: profile.photosSinceExport + 1 }));
        }
        if (draftId) await requestResult(stores.drafts.delete(draftId));
        return saved;
      },
    );
  }

  async createLinkedIdea(
    sourceIdeaId: string,
    sourceSubtaskId: string,
    input: Idea,
    image: DraftImage | null,
    draftId?: string,
  ): Promise<Idea> {
    const idea = trimStatusHistory({
      ...input,
      sourceIdeaId,
      sourceSubtaskId,
      sourceWasDeleted: false,
    });
    validateIdea(idea);
    if (image) this.validateDraftImage(image);
    return this.withTransaction(
      ["ideas", "categories", "images", "drafts", "profiles"],
      "readwrite",
      "createLinkedIdea",
      async (stores) => {
        const source = await requestResult<Idea | undefined>(stores.ideas.get(sourceIdeaId));
        if (!source || source.profileId !== idea.profileId) {
          throw new StorageError("VALIDATION_FAILED", "Исходная идея не найдена.", "createLinkedIdea");
        }
        const subtask = findSubtask(source, sourceSubtaskId);
        if (!subtask) {
          throw new StorageError("VALIDATION_FAILED", "Исходная подзадача не найдена.", "createLinkedIdea");
        }
        if (subtask.linkedIdeaId) {
          throw new StorageError("VALIDATION_FAILED", "Для подзадачи уже создана отдельная идея.", "createLinkedIdea");
        }
        const category = await requestResult<Category | undefined>(stores.categories.get(idea.categoryId));
        if (!category || category.profileId !== idea.profileId) {
          throw new StorageError("VALIDATION_FAILED", "Категория идеи не найдена.", "createLinkedIdea");
        }
        const count = await requestResult(stores.ideas.index("profileId").count(idea.profileId));
        if (count >= LIMITS.ideasPerProfile) throw limitError("Достигнут лимит идей профиля.");
        subtask.linkedIdeaId = idea.id;
        source.updatedAt = idea.createdAt;
        const saved = { ...idea, hasImage: image !== null };
        await requestResult(stores.ideas.put(source));
        await requestResult(stores.ideas.add(saved));
        await this.writeImageInTransaction(stores.images, saved, image);
        if (image) {
          const profile = await requestResult<Profile | undefined>(stores.profiles.get(saved.profileId));
          if (profile) await requestResult(stores.profiles.put({ ...profile, photosSinceExport: profile.photosSinceExport + 1 }));
        }
        if (draftId) await requestResult(stores.drafts.delete(draftId));
        return saved;
      },
    );
  }

  async deleteIdeaConnected(profileId: string, ideaId: string): Promise<void> {
    await this.withTransaction(
      ["ideas", "images", "drafts"],
      "readwrite",
      "deleteIdeaConnected",
      async (stores) => {
        const idea = await requestResult<Idea | undefined>(stores.ideas.get(ideaId));
        if (!idea || idea.profileId !== profileId) return;
        const ideas = await requestResult<Idea[]>(stores.ideas.index("profileId").getAll(profileId));
        for (const candidate of ideas) {
          if (candidate.id === ideaId) continue;
          let changed = false;
          if (candidate.sourceIdeaId === ideaId) {
            candidate.sourceIdeaId = null;
            candidate.sourceSubtaskId = null;
            candidate.sourceWasDeleted = true;
            changed = true;
          }
          for (const subtask of candidate.subtasks) {
            if (subtask.linkedIdeaId === ideaId) {
              subtask.linkedIdeaId = null;
              changed = true;
            }
            for (const child of subtask.children) {
              if (child.linkedIdeaId === ideaId) {
                child.linkedIdeaId = null;
                changed = true;
              }
            }
          }
          if (linkedIdeaIds(idea).has(candidate.id) && candidate.sourceIdeaId === ideaId) {
            candidate.sourceIdeaId = null;
            candidate.sourceSubtaskId = null;
            candidate.sourceWasDeleted = true;
            changed = true;
          }
          if (changed) await requestResult(stores.ideas.put(candidate));
        }
        await Promise.all([
          requestResult(stores.ideas.delete(ideaId)),
          requestResult(stores.images.delete(ideaId)),
          requestResult(stores.drafts.delete(`${profileId}:draft_edit_${ideaId}`)),
        ]);
      },
    );
  }

  async saveImage(image: ImageRecord): Promise<void> {
    validateImage(image);
    await this.withTransaction(["images", "ideas"], "readwrite", "saveImage", async (stores) => {
      const idea = await requestResult<Idea | undefined>(stores.ideas.get(image.ideaId));
      if (!idea || idea.profileId !== image.profileId) {
        throw new StorageError("VALIDATION_FAILED", "Идея для изображения не найдена.", "saveImage");
      }
      const store = stores.images;
      const existing = await requestResult<ImageRecord | undefined>(store.get(image.ideaId));
      const images = await requestResult<ImageRecord[]>(store.index("profileId").getAll(image.profileId));
      if (!existing && images.length >= LIMITS.ideasWithImagesPerProfile) {
        throw limitError("Достигнут лимит идей с фотографиями.");
      }
      const totalBytes = images.reduce((total, item) => total + item.blob.size, 0)
        - (existing?.blob.size ?? 0)
        + image.blob.size;
      if (totalBytes > LIMITS.imageBytesPerProfile) {
        throw limitError("Достигнут лимит размера фотографий профиля.");
      }
      await requestResult(store.put(image));
    });
  }

  async getImage(ideaId: string): Promise<ImageRecord | null> {
    return this.readOne<ImageRecord>("images", ideaId, "getImage");
  }

  async listImages(profileId: string): Promise<ImageRecord[]> {
    const images = await this.readByIndex<ImageRecord>("images", "profileId", profileId, "listImages");
    images.forEach(validateImage);
    return images;
  }

  async getProfileBundle(profileId: string): Promise<ProfileBundle> {
    const [profile, categories, ideas, images, drafts] = await Promise.all([
      this.getProfile(profileId),
      this.listCategories(profileId),
      this.listIdeas(profileId),
      this.listImages(profileId),
      this.listDrafts(profileId),
    ]);
    if (!profile) throw new StorageError("VALIDATION_FAILED", "Профиль не найден.", "getProfileBundle");
    return { profile, categories, ideas, images, drafts };
  }

  async importProfileBundle(bundle: ProfileBundle, replaceProfileId?: string): Promise<void> {
    validateProfile(bundle.profile);
    bundle.categories.forEach(validateCategory);
    bundle.ideas.forEach(validateIdea);
    bundle.images.forEach(validateImage);
    if (bundle.categories.some((item) => item.profileId !== bundle.profile.id) ||
      bundle.ideas.some((item) => item.profileId !== bundle.profile.id) ||
      bundle.images.some((item) => item.profileId !== bundle.profile.id) ||
      bundle.drafts.some((item) => item.profileId !== bundle.profile.id)) {
      throw new StorageError("VALIDATION_FAILED", "Данные резервной копии относятся к разным профилям.", "importProfileBundle");
    }
    if (bundle.ideas.length > LIMITS.ideasPerProfile || bundle.images.length > LIMITS.ideasWithImagesPerProfile ||
      bundle.images.reduce((total, image) => total + image.blob.size, 0) > LIMITS.imageBytesPerProfile) {
      throw limitError("Резервная копия превышает ограничения профиля.");
    }
    const categoryIds = new Set(bundle.categories.map(({ id }) => id));
    const ideaIds = new Set(bundle.ideas.map(({ id }) => id));
    if (bundle.ideas.some((idea) => !categoryIds.has(idea.categoryId)) || bundle.images.some((image) => !ideaIds.has(image.ideaId))) {
      throw new StorageError("VALIDATION_FAILED", "В резервной копии повреждены обязательные связи.", "importProfileBundle");
    }
    await this.withTransaction(
      ["profiles", "categories", "ideas", "images", "drafts"],
      "readwrite",
      "importProfileBundle",
      async (stores) => {
        if (replaceProfileId) {
          await Promise.all([
            requestResult(stores.profiles.delete(replaceProfileId)),
            this.deleteIndexMatches(stores.categories, "profileId", replaceProfileId),
            this.deleteIndexMatches(stores.ideas, "profileId", replaceProfileId),
            this.deleteIndexMatches(stores.images, "profileId", replaceProfileId),
            this.deleteIndexMatches(stores.drafts, "profileId", replaceProfileId),
          ]);
        }
        await requestResult(stores.profiles.add(bundle.profile));
        for (const category of bundle.categories) await requestResult(stores.categories.add(category));
        for (const idea of bundle.ideas) await requestResult(stores.ideas.add(idea));
        for (const image of bundle.images) await requestResult(stores.images.add(image));
        for (const draft of bundle.drafts) await requestResult(stores.drafts.add(draft));
      },
    );
  }

  async deleteImage(ideaId: string): Promise<void> {
    await this.deleteOne("images", ideaId, "deleteImage");
  }

  async saveDraft(draft: DraftRecord): Promise<void> {
    if (draft.id !== `${draft.profileId}:${draft.formId}`) {
      throw new StorageError("VALIDATION_FAILED", "Неверный идентификатор черновика.", "saveDraft");
    }
    if (draft.image) this.validateDraftImage(draft.image);
    await this.withTransaction(["profiles", "drafts"], "readwrite", "saveDraft", async (stores) => {
      const profile = await requestResult<Profile | undefined>(stores.profiles.get(draft.profileId));
      if (!profile) {
        throw new StorageError("VALIDATION_FAILED", "Профиль черновика не найден.", "saveDraft");
      }
      await requestResult(stores.drafts.put(draft));
    });
  }

  async getDraft(id: string): Promise<DraftRecord | null> {
    return this.readOne<DraftRecord>("drafts", id, "getDraft");
  }

  async listDrafts(profileId: string): Promise<DraftRecord[]> {
    return this.readByIndex<DraftRecord>("drafts", "profileId", profileId, "listDrafts");
  }

  async deleteDraft(id: string): Promise<void> {
    await this.deleteOne("drafts", id, "deleteDraft");
  }

  async appendDiagnostic(record: Omit<DiagnosticRecord, "id">): Promise<void> {
    try {
      await this.withTransaction(["diagnostics"], "readwrite", "appendDiagnostic", async (stores) => {
        const store = stores.diagnostics;
        await requestResult(store.add(sanitizeDiagnostic(record)));
        const count = await requestResult(store.count());
        let excess = count - LIMITS.diagnostics;
        if (excess <= 0) return;

        await new Promise<void>((resolve, reject) => {
          const cursorRequest = store.openCursor();
          cursorRequest.addEventListener("error", () => reject(cursorRequest.error), { once: true });
          cursorRequest.addEventListener("success", () => {
            const cursor = cursorRequest.result;
            if (!cursor || excess <= 0) {
              resolve();
              return;
            }
            cursor.delete();
            excess -= 1;
            cursor.continue();
          });
        });
      });
    } catch {
      // Сбой необязательного журнала не должен мешать основной работе.
    }
  }

  async logError(error: unknown, operation: string): Promise<void> {
    const normalized = normalizeStorageError(error, operation);
    await this.appendDiagnostic({
      occurredAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      browserType: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      errorCode: normalized.code,
      operation,
      message: normalized.message,
    });
  }

  async listDiagnostics(): Promise<DiagnosticRecord[]> {
    return this.readAll<DiagnosticRecord>("diagnostics", "listDiagnostics");
  }

  async clearDiagnostics(): Promise<void> {
    await this.withTransaction(["diagnostics"], "readwrite", "clearDiagnostics", async (stores) => {
      await requestResult(stores.diagnostics.clear());
    });
  }

  async estimateStorage(): Promise<StorageEstimate> {
    const manager = typeof navigator === "undefined" ? undefined : navigator.storage;
    if (!manager) return { usage: null, quota: null, persistent: null };
    const [estimate, persistent] = await Promise.all([
      manager.estimate?.() ?? Promise.resolve({}),
      manager.persisted?.() ?? Promise.resolve(false),
    ]);
    return {
      usage: estimate.usage ?? null,
      quota: estimate.quota ?? null,
      persistent,
    };
  }

  async requestPersistentStorage(): Promise<boolean | null> {
    const manager = typeof navigator === "undefined" ? undefined : navigator.storage;
    if (!manager?.persist) return null;
    return manager.persist();
  }

  async deleteProfileData(profileId: string): Promise<void> {
    await this.withTransaction(
      ["profiles", "categories", "ideas", "images", "drafts"],
      "readwrite",
      "deleteProfileData",
      async (stores) => {
        await Promise.all([
          requestResult(stores.profiles.delete(profileId)),
          this.deleteIndexMatches(stores.categories, "profileId", profileId),
          this.deleteIndexMatches(stores.ideas, "profileId", profileId),
          this.deleteIndexMatches(stores.images, "profileId", profileId),
          this.deleteIndexMatches(stores.drafts, "profileId", profileId),
        ]);
      },
    );
  }

  async clearProfileContent(profileId: string): Promise<void> {
    await this.withTransaction(
      ["profiles", "categories", "ideas", "images", "drafts"],
      "readwrite",
      "clearProfileContent",
      async (stores) => {
        const profile = await requestResult<Profile | undefined>(stores.profiles.get(profileId));
        if (!profile) {
          throw new StorageError("VALIDATION_FAILED", "Профиль не найден.", "clearProfileContent");
        }
        const categories = await requestResult<Category[]>(
          stores.categories.index("profileId").getAll(profileId),
        );
        const systemCategories = categories.filter((category) => category.isSystem);
        if (systemCategories.length !== 2) {
          throw new StorageError(
            "CORRUPTED_DATA",
            "Начальные категории профиля повреждены.",
            "clearProfileContent",
          );
        }

        await Promise.all([
          this.deleteIndexMatches(stores.categories, "profileId", profileId),
          this.deleteIndexMatches(stores.ideas, "profileId", profileId),
          this.deleteIndexMatches(stores.images, "profileId", profileId),
          this.deleteIndexMatches(stores.drafts, "profileId", profileId),
        ]);

        const resetCategories: Category[] = systemCategories.map((category) => ({
          ...category,
          name: category.systemKey === "personal" ? "Личное" : "Работа",
          nameNormalized: category.systemKey === "personal" ? "личное" : "работа",
        }));
        for (const category of resetCategories) await requestResult(stores.categories.put(category));
      },
    );
  }

  private async readOne<T>(storeName: StoreName, key: IDBValidKey, operation: string): Promise<T | null> {
    return this.withTransaction([storeName], "readonly", operation, async (stores) => {
      const value = await requestResult<T | undefined>(stores[storeName].get(key));
      return value ?? null;
    });
  }

  private async readAll<T>(storeName: StoreName, operation: string): Promise<T[]> {
    return this.withTransaction([storeName], "readonly", operation, (stores) =>
      requestResult<T[]>(stores[storeName].getAll()),
    );
  }

  private async readByIndex<T>(
    storeName: StoreName,
    indexName: string,
    key: IDBValidKey,
    operation: string,
  ): Promise<T[]> {
    return this.withTransaction([storeName], "readonly", operation, (stores) =>
      requestResult<T[]>(stores[storeName].index(indexName).getAll(key)),
    );
  }

  private async writeOne(storeName: StoreName, value: unknown, operation: string): Promise<void> {
    await this.withTransaction([storeName], "readwrite", operation, async (stores) => {
      await requestResult(stores[storeName].put(value));
    });
  }

  private async deleteOne(storeName: StoreName, key: IDBValidKey, operation: string): Promise<void> {
    await this.withTransaction([storeName], "readwrite", operation, async (stores) => {
      await requestResult(stores[storeName].delete(key));
    });
  }

  private async withTransaction<T>(
    storeNames: StoreName[],
    mode: IDBTransactionMode,
    operation: string,
    action: (stores: Record<StoreName, IDBObjectStore>) => Promise<T> | T,
  ): Promise<T> {
    const transaction = this.database.transaction(storeNames, mode);
    const completion = transactionComplete(transaction);
    const stores = {} as Record<StoreName, IDBObjectStore>;
    for (const storeName of storeNames) stores[storeName] = transaction.objectStore(storeName);

    try {
      const result = await action(stores);
      await completion;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Транзакция уже завершилась или была отменена браузером.
      }
      await completion.catch(() => undefined);
      throw normalizeStorageError(error, operation);
    }
  }

  private async deleteIndexMatches(
    store: IDBObjectStore,
    indexName: string,
    key: IDBValidKey,
  ): Promise<void> {
    const keys = await requestResult(store.index(indexName).getAllKeys(key));
    await Promise.all(keys.map((itemKey) => requestResult(store.delete(itemKey))));
  }

  private validateDraftImage(image: DraftImage): void {
    validateImage({
      ideaId: "draft",
      profileId: "draft",
      ...image,
    });
  }

  private async writeImageInTransaction(
    store: IDBObjectStore,
    idea: Idea,
    image: DraftImage | null | undefined,
  ): Promise<void> {
    if (image === undefined) return;
    if (image === null) {
      await requestResult(store.delete(idea.id));
      return;
    }
    const existing = await requestResult<ImageRecord | undefined>(store.get(idea.id));
    const images = await requestResult<ImageRecord[]>(store.index("profileId").getAll(idea.profileId));
    if (!existing && images.length >= LIMITS.ideasWithImagesPerProfile) {
      throw limitError("Достигнут лимит идей с фотографиями.");
    }
    const totalBytes = images.reduce((total, item) => total + item.blob.size, 0)
      - (existing?.blob.size ?? 0) + image.blob.size;
    if (totalBytes > LIMITS.imageBytesPerProfile) {
      throw limitError("Достигнут лимит размера фотографий профиля.");
    }
    await requestResult(store.put({ ideaId: idea.id, profileId: idea.profileId, ...image }));
  }
}
