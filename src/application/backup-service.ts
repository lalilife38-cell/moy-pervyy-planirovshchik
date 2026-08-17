import { hashPin, validatePinFormat, verifyPin } from "../auth/pin";
import { BACKUP_LIMITS } from "../domain/constants";
import type {
  Category,
  DraftImage,
  DraftRecord,
  Idea,
  ImageRecord,
  NestedSubtask,
  Profile,
  ProfileBundle,
  Subtask,
} from "../domain/types";
import { IdeaDatabase } from "../storage/database";
import { UserInputError, normalizeName } from "./profile-service";

const BACKUP_SCHEMA_VERSION = 1;

interface PortableImage {
  ideaId: string;
  mimeType: ImageRecord["mimeType"];
  width: number;
  height: number;
  savedAt: string;
  base64: string;
}

interface PortableDraft extends Omit<DraftRecord, "image"> {
  image: (Omit<DraftImage, "blob"> & { base64: string }) | null;
}

export interface BackupEnvelope {
  schemaVersion: number;
  app: "Время идеи";
  exportedAt: string;
  profile: Omit<Profile, "pinHash" | "pinSalt">;
  categories: Category[];
  ideas: Idea[];
  drafts: PortableDraft[];
  images: PortableImage[];
  report: { photosIncluded: boolean; omittedImages: number; warnings: string[] };
}

export interface ExportEstimate {
  estimatedBytes: number;
  imageCount: number;
  requiresWarning: boolean;
  exceedsMaximumWithPhotos: boolean;
}

export interface ImportOptions {
  name: string;
  pin: string;
  pinConfirmation: string;
  replace?: { profileId: string; currentPin: string; confirmationWord: string };
}

export interface ImportResult {
  profileId: string;
  ideaCount: number;
  imageCount: number;
  warnings: string[];
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Операция отменена.", "AbortError");
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBlob(value: string, mimeType: string): Blob {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new UserInputError("В резервной копии повреждено изображение.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function plainText(value: unknown, maximum: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/<\/?[a-z][^>]*>/gi, "").slice(0, maximum);
}

function requiredText(value: unknown, maximum: number, label: string): string {
  const result = plainText(value, maximum).trim();
  if (!result) throw new UserInputError(`В резервной копии отсутствует поле «${label}».`);
  return result;
}

function portableProfile(profile: Profile): Omit<Profile, "pinHash" | "pinSalt"> {
  const { pinHash: _pinHash, pinSalt: _pinSalt, ...portable } = profile;
  return structuredClone(portable);
}

function approximatePortableBytes(bundle: ProfileBundle): number {
  const binary = bundle.images.reduce((total, image) => total + image.blob.size, 0) +
    bundle.drafts.reduce((total, draft) => total + (draft.image?.blob.size ?? 0), 0);
  const metadata = JSON.stringify({
    profile: portableProfile(bundle.profile), categories: bundle.categories, ideas: bundle.ideas,
    drafts: bundle.drafts.map((draft) => ({ ...draft, image: draft.image ? { ...draft.image, blob: undefined } : null })),
  }).length;
  return metadata + Math.ceil(binary * 4 / 3) + 4096;
}

function validateEnvelope(value: unknown): BackupEnvelope {
  if (!value || typeof value !== "object") throw new UserInputError("Файл не является резервной копией «Время идеи».");
  const backup = value as Partial<BackupEnvelope>;
  if (backup.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new UserInputError("Версия резервной копии не поддерживается.");
  if (backup.app !== "Время идеи" || !backup.profile || !Array.isArray(backup.categories) ||
    !Array.isArray(backup.ideas) || !Array.isArray(backup.drafts) || !Array.isArray(backup.images)) {
    throw new UserInputError("Структура резервной копии повреждена.");
  }
  return backup as BackupEnvelope;
}

export class BackupService {
  constructor(
    private readonly database: IdeaDatabase,
    private readonly activeProfileId: () => string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async estimateCurrentExport(): Promise<ExportEstimate> {
    const bundle = await this.database.getProfileBundle(this.requireProfileId());
    const estimatedBytes = approximatePortableBytes(bundle);
    return {
      estimatedBytes,
      imageCount: bundle.images.length + bundle.drafts.filter((draft) => draft.image).length,
      requiresWarning: estimatedBytes > BACKUP_LIMITS.warningBytes,
      exceedsMaximumWithPhotos: estimatedBytes > BACKUP_LIMITS.maximumExportBytes,
    };
  }

  async exportCurrentProfile(
    includePhotos: boolean,
    onProgress: (done: number, total: number) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<{ text: string; filename: string; envelope: BackupEnvelope }> {
    const bundle = await this.database.getProfileBundle(this.requireProfileId());
    if (includePhotos && approximatePortableBytes(bundle) > BACKUP_LIMITS.maximumExportBytes) {
      throw new UserInputError("Копия с фотографиями превышает 40 МБ. Экспортируйте без фотографий или удалите часть фото.");
    }
    const sources = bundle.images.length + bundle.drafts.filter((draft) => draft.image).length;
    let done = 0;
    const images: PortableImage[] = [];
    if (includePhotos) {
      for (const image of bundle.images) {
        assertNotCancelled(signal);
        images.push({ ...image, blob: undefined, base64: await blobToBase64(image.blob) } as unknown as PortableImage);
        done += 1;
        onProgress(done, sources);
      }
    }
    const drafts: PortableDraft[] = [];
    for (const draft of bundle.drafts) {
      assertNotCancelled(signal);
      let image: PortableDraft["image"] = null;
      if (includePhotos && draft.image) {
        const { blob, ...metadata } = draft.image;
        image = { ...metadata, base64: await blobToBase64(blob) };
        done += 1;
        onProgress(done, sources);
      }
      drafts.push({ ...draft, image });
    }
    const omittedImages = includePhotos ? 0 : sources;
    const envelope: BackupEnvelope = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      app: "Время идеи",
      exportedAt: this.now().toISOString(),
      profile: portableProfile(bundle.profile),
      categories: structuredClone(bundle.categories),
      ideas: structuredClone(bundle.ideas),
      drafts,
      images,
      report: { photosIncluded: includePhotos, omittedImages, warnings: omittedImages ? [`Не включено фотографий: ${omittedImages}.`] : [] },
    };
    const text = JSON.stringify(envelope);
    if (new Blob([text]).size > BACKUP_LIMITS.maximumExportBytes) {
      throw new UserInputError("Размер итоговой копии превышает 40 МБ. Экспортируйте без фотографий.");
    }
    const safeName = bundle.profile.name.toLocaleLowerCase("ru-RU").replace(/[^a-zа-яё0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "profile";
    const date = this.now().toLocaleDateString("sv-SE");
    return { text, filename: `vremya-idei_${safeName}_${date}.json`, envelope };
  }

  parseBackup(text: string, byteSize = new Blob([text]).size): BackupEnvelope {
    if (byteSize > BACKUP_LIMITS.maximumImportBytes) throw new UserInputError("Файл превышает допустимый размер 50 МБ.");
    try {
      return validateEnvelope(JSON.parse(text));
    } catch (error) {
      if (error instanceof UserInputError) throw error;
      throw new UserInputError("Не удалось прочитать JSON резервной копии.");
    }
  }

  async importBackup(
    backupInput: BackupEnvelope,
    options: ImportOptions,
    onProgress: (stage: string, done: number, total: number) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<ImportResult> {
    const backup = validateEnvelope(backupInput);
    if (backup.categories.some((item) => !item || typeof item !== "object") ||
      backup.ideas.some((item) => !item || typeof item !== "object" || !Array.isArray(item.subtasks) || !Array.isArray(item.statusHistory) || !item.complexDetails) ||
      backup.drafts.some((item) => !item || typeof item !== "object" || !item.data || typeof item.data !== "object") ||
      backup.images.some((item) => !item || typeof item.base64 !== "string" || typeof item.mimeType !== "string")) {
      throw new UserInputError("В резервной копии повреждены обязательные данные.");
    }
    const name = requiredText(options.name, 40, "имя профиля");
    if (!validatePinFormat(options.pin)) throw new UserInputError("Новый PIN должен состоять ровно из 4 цифр.", "importPin");
    if (options.pin !== options.pinConfirmation) throw new UserInputError("Новые PIN-коды не совпадают.", "importPinConfirmation");
    const duplicate = await this.database.findProfileByNormalizedName(normalizeName(name));
    let replaceId: string | undefined;
    if (duplicate) {
      if (!options.replace || options.replace.profileId !== duplicate.id) {
        throw new UserInputError("Профиль с таким именем уже существует. Создайте копию с другим именем или выберите замену.");
      }
      if (options.replace.confirmationWord !== "УДАЛИТЬ" ||
        !(await verifyPin(options.replace.currentPin, duplicate.pinHash, duplicate.pinSalt))) {
        throw new UserInputError("Для замены нужен верный PIN существующего профиля и слово УДАЛИТЬ.");
      }
      replaceId = duplicate.id;
    } else if (options.replace) {
      throw new UserInputError("Профиль для замены не найден.");
    }
    assertNotCancelled(signal);
    const targetProfileId = replaceId ?? crypto.randomUUID();
    const credentials = await hashPin(options.pin);
    const categoryMap = new Map<string, string>();
    const ideaMap = new Map<string, string>();
    const subtaskMap = new Map<string, string>();
    for (const category of backup.categories) categoryMap.set(category.id, crypto.randomUUID());
    for (const idea of backup.ideas) ideaMap.set(idea.id, crypto.randomUUID());
    for (const idea of backup.ideas) for (const task of idea.subtasks) {
      subtaskMap.set(task.id, crypto.randomUUID());
      for (const child of task.children) subtaskMap.set(child.id, crypto.randomUUID());
    }
    const warnings: string[] = [];
    const remapTask = (task: NestedSubtask): NestedSubtask => {
      if (task.linkedIdeaId && !ideaMap.has(task.linkedIdeaId)) warnings.push(`Очищена повреждённая ссылка подзадачи ${task.id}.`);
      return {
        ...task,
        id: subtaskMap.get(task.id)!,
        title: requiredText(task.title, 200, "название подзадачи"),
        description: plainText(task.description, 1000),
        linkedIdeaId: task.linkedIdeaId && ideaMap.has(task.linkedIdeaId) ? ideaMap.get(task.linkedIdeaId)! : null,
      };
    };
    const categories: Category[] = backup.categories.map((item) => {
      const categoryName = requiredText(item.name, 30, "название категории");
      return { ...item, id: categoryMap.get(item.id)!, profileId: targetProfileId, name: categoryName, nameNormalized: normalizeName(categoryName) };
    });
    const oldIdeas = new Map(backup.ideas.map((idea) => [idea.id, idea]));
    const ideas: Idea[] = backup.ideas.map((item) => {
      const oldSource = item.sourceIdeaId ? oldIdeas.get(item.sourceIdeaId) : undefined;
      const sourceOwnsSubtask = Boolean(oldSource && item.sourceSubtaskId && oldSource.subtasks.some((task) =>
        task.id === item.sourceSubtaskId || task.children.some((child) => child.id === item.sourceSubtaskId),
      ));
      const sourceValid = Boolean(item.sourceIdeaId && item.sourceSubtaskId && ideaMap.has(item.sourceIdeaId) && subtaskMap.has(item.sourceSubtaskId) && sourceOwnsSubtask);
      if ((item.sourceIdeaId || item.sourceSubtaskId) && !sourceValid) warnings.push(`Очищена повреждённая исходная ссылка идеи ${item.id}.`);
      const categoryId = categoryMap.get(item.categoryId);
      if (!categoryId) throw new UserInputError("В резервной копии идея ссылается на отсутствующую категорию.");
      return {
        ...item,
        id: ideaMap.get(item.id)!,
        profileId: targetProfileId,
        title: requiredText(item.title, 120, "название идеи"),
        description: requiredText(item.description, 1000, "описание идеи"),
        notes: plainText(item.notes, 5000),
        categoryId,
        complexDetails: {
          ...item.complexDetails,
          expectedResult: plainText(item.complexDetails?.expectedResult, 2000),
          requiredResources: plainText(item.complexDetails?.requiredResources, 2000),
          blockers: plainText(item.complexDetails?.blockers, 2000),
          firstStep: plainText(item.complexDetails?.firstStep, 2000),
          deadlineComment: plainText(item.complexDetails?.deadlineComment, 500),
        },
        subtasks: item.subtasks.map((task): Subtask => ({
          ...remapTask(task),
          children: task.children.map(remapTask),
        })),
        sourceIdeaId: sourceValid ? ideaMap.get(item.sourceIdeaId!)! : null,
        sourceSubtaskId: sourceValid ? subtaskMap.get(item.sourceSubtaskId!)! : null,
        sourceWasDeleted: sourceValid ? false : item.sourceWasDeleted,
        statusHistory: item.statusHistory.slice(-100).map((entry) => ({ ...entry, id: crypto.randomUUID() })),
        hasImage: false,
      };
    });
    const ideaById = new Map(ideas.map((idea) => [idea.id, idea]));
    for (const start of ideas) {
      const path: string[] = [];
      let current: Idea | undefined = start;
      while (current?.sourceIdeaId) {
        const cycleAt = path.indexOf(current.id);
        if (cycleAt >= 0) {
          for (const id of path.slice(cycleAt)) {
            const cyclic = ideaById.get(id);
            if (cyclic) { cyclic.sourceIdeaId = null; cyclic.sourceSubtaskId = null; }
          }
          warnings.push("Очищена циклическая связь между идеями.");
          break;
        }
        path.push(current.id);
        current = ideaById.get(current.sourceIdeaId);
      }
    }
    const imageSources = backup.images;
    const draftImageSources = backup.drafts.filter((draft) => draft.image);
    const totalImages = imageSources.length + draftImageSources.length;
    const approximateImageBytes = [...imageSources, ...draftImageSources.map((draft) => draft.image!)].reduce((total, item) => total + Math.floor(item.base64.length * 3 / 4), 0);
    const estimate = await this.database.estimateStorage();
    if (estimate.quota !== null && estimate.usage !== null && estimate.quota - estimate.usage < approximateImageBytes) {
      throw new UserInputError("Недостаточно места для импорта. Освободите хранилище или используйте копию без фотографий.");
    }
    const images: ImageRecord[] = [];
    let done = 0;
    for (const item of imageSources) {
      assertNotCancelled(signal);
      const ideaId = ideaMap.get(item.ideaId);
      if (!ideaId) {
        warnings.push(`Пропущено изображение без идеи ${item.ideaId}.`);
        continue;
      }
      const blob = base64ToBlob(item.base64, item.mimeType);
      images.push({ ideaId, profileId: targetProfileId, blob, mimeType: item.mimeType, width: item.width, height: item.height, savedAt: item.savedAt });
      const idea = ideaById.get(ideaId);
      if (idea) idea.hasImage = true;
      done += 1;
      onProgress("Фотографии", done, totalImages);
    }
    const drafts: DraftRecord[] = [];
    for (const item of backup.drafts) {
      assertNotCancelled(signal);
      const editMatch = /^draft_edit_(.+)$/.exec(item.formId);
      const mappedFormId = editMatch ? `draft_edit_${ideaMap.get(editMatch[1]!) ?? crypto.randomUUID()}` as const : "draft_new" as const;
      let image: DraftImage | null = null;
      if (item.image) {
        const { base64, ...metadata } = item.image;
        image = { ...metadata, blob: base64ToBlob(base64, metadata.mimeType) };
        done += 1;
        onProgress("Черновики", done, totalImages);
      }
      const data = structuredClone(item.data);
      if (data.categoryId) data.categoryId = categoryMap.get(data.categoryId) ?? categories[0]?.id;
      if (data.sourceIdeaId) data.sourceIdeaId = ideaMap.get(data.sourceIdeaId) ?? null;
      if (data.sourceSubtaskId) data.sourceSubtaskId = subtaskMap.get(data.sourceSubtaskId) ?? null;
      if (data.title) data.title = plainText(data.title, 120);
      if (data.description) data.description = plainText(data.description, 1000);
      if (data.notes) data.notes = plainText(data.notes, 5000);
      drafts.push({
        id: `${targetProfileId}:${mappedFormId}`,
        profileId: targetProfileId,
        formId: mappedFormId,
        data,
        image,
        updatedAt: item.updatedAt,
      });
    }
    const sourceProfile = backup.profile;
    const profile: Profile = {
      id: targetProfileId,
      name,
      nameNormalized: normalizeName(name),
      ...credentials,
      createdAt: sourceProfile.createdAt || this.now().toISOString(),
      settings: {
        theme: sourceProfile.settings?.theme === "dark" ? "dark" : "light",
        view: sourceProfile.settings?.view === "list" ? "list" : "cards",
        filters: sourceProfile.settings?.filters ?? {},
        sortBy: sourceProfile.settings?.sortBy ?? "returnDate",
        sortDirection: sourceProfile.settings?.sortDirection ?? "asc",
        notificationsEnabled: false,
        notifiedOn: {},
      },
      lastSuccessfulExportAt: null,
      photosSinceExport: 0,
      lastBackupReminderAt: null,
    };
    const bundle: ProfileBundle = { profile, categories, ideas, images, drafts };
    onProgress("Сохранение", totalImages, totalImages);
    assertNotCancelled(signal);
    await this.database.importProfileBundle(bundle, replaceId);
    return { profileId: targetProfileId, ideaCount: ideas.length, imageCount: images.length, warnings };
  }

  async suggestCopyName(baseName: string): Promise<string> {
    const trimmed = plainText(baseName, 40, "Профиль") || "Профиль";
    for (let index = 1; index < 10_000; index += 1) {
      const suffix = index === 1 ? " — копия" : ` — копия ${index}`;
      const candidate = `${trimmed.slice(0, 40 - suffix.length)}${suffix}`;
      if (!(await this.database.findProfileByNormalizedName(normalizeName(candidate)))) return candidate;
    }
    throw new UserInputError("Не удалось подобрать имя копии.");
  }

  private requireProfileId(): string {
    const id = this.activeProfileId();
    if (!id) throw new UserInputError("Сначала войдите в профиль.");
    return id;
  }
}
