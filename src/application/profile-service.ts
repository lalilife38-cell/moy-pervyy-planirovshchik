import { addCalendarDays, toLocalCalendarDate } from "../domain/dates";
import type { Category, Idea, Profile, ProfileSettings } from "../domain/types";
import { hashPin, validatePinFormat, verifyPin } from "../auth/pin";
import { LoginAttemptGuard } from "../auth/login-guard";
import { IdeaDatabase } from "../storage/database";

export class UserInputError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "UserInputError";
  }
}

export interface PublicProfile {
  id: string;
  name: string;
}

export interface CreateProfileInput {
  name: string;
  pin: string;
  pinConfirmation: string;
  recoveryWarningAccepted: boolean;
}

export interface ActiveSession {
  profileId: string;
  profileName: string;
}

export function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU");
}

function validateProfileName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 40) {
    throw new UserInputError("Введите имя длиной от 1 до 40 символов.", "name");
  }
  return name;
}

function validateCategoryName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 30) {
    throw new UserInputError("Название категории должно содержать от 1 до 30 символов.", "categoryName");
  }
  return name;
}

function makeDemonstrationIdea(profileId: string, categoryId: string, now: Date): Idea {
  const timestamp = now.toISOString();
  return {
    id: crypto.randomUUID(),
    profileId,
    title: "Продумать место для короткой поездки",
    description: "Сохранить несколько вариантов и вернуться к выбору через две недели",
    notes: "",
    categoryId,
    priority: "medium",
    complexity: "complex",
    status: "new",
    createdAt: timestamp,
    updatedAt: timestamp,
    returnDate: addCalendarDays(toLocalCalendarDate(now), 14),
    returnMode: "date",
    returnWeeks: null,
    recurrenceEligible: false,
    completedAt: null,
    rejectedAt: null,
    hasImage: false,
    complexDetails: {
      isMultiStage: true,
      expectedResult: "Выбрать подходящее место для короткой поездки",
      requiredResources: "Список вариантов и примерный бюджет",
      blockers: "",
      firstStep: "Собрать несколько направлений",
      hasDeadline: false,
      deadlineComment: "",
    },
    subtasks: [
      {
        id: crypto.randomUUID(),
        title: "Записать три возможных направления",
        description: "",
        completed: false,
        createdAt: timestamp,
        completedAt: null,
        linkedIdeaId: null,
        children: [],
      },
    ],
    sourceIdeaId: null,
    sourceSubtaskId: null,
    sourceWasDeleted: false,
    statusHistory: [],
  };
}

export class ProfileService {
  private activeProfile: Profile | null = null;

  constructor(
    private readonly database: IdeaDatabase,
    private readonly loginGuard = new LoginAttemptGuard(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  get session(): ActiveSession | null {
    return this.activeProfile
      ? { profileId: this.activeProfile.id, profileName: this.activeProfile.name }
      : null;
  }

  async listPublicProfiles(): Promise<PublicProfile[]> {
    return (await this.database.listProfiles())
      .map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  }

  async createProfile(input: CreateProfileInput): Promise<PublicProfile> {
    const name = validateProfileName(input.name);
    if (!validatePinFormat(input.pin)) {
      throw new UserInputError("PIN должен состоять ровно из 4 цифр.", "pin");
    }
    if (input.pin !== input.pinConfirmation) {
      throw new UserInputError("PIN-коды не совпадают.", "pinConfirmation");
    }
    if (!input.recoveryWarningAccepted) {
      throw new UserInputError("Подтвердите, что понимаете: забытый PIN восстановить нельзя.", "recoveryWarning");
    }
    const nameNormalized = normalizeName(name);
    if (await this.database.findProfileByNormalizedName(nameNormalized)) {
      throw new UserInputError("Профиль с таким именем уже существует.", "name");
    }

    const now = this.now();
    const createdAt = now.toISOString();
    const id = crypto.randomUUID();
    const credentials = await hashPin(input.pin);
    const profile: Profile = {
      id,
      name,
      nameNormalized,
      ...credentials,
      createdAt,
      settings: {
        theme: "light",
        view: "cards",
        filters: {},
        sortBy: "returnDate",
        sortDirection: "asc",
        notificationsEnabled: false,
        notifiedOn: {},
      },
      lastSuccessfulExportAt: null,
      photosSinceExport: 0,
      lastBackupReminderAt: null,
    };
    const personal: Category = {
      id: crypto.randomUUID(),
      profileId: id,
      name: "Личное",
      nameNormalized: "личное",
      isSystem: true,
      systemKey: "personal",
      createdAt,
    };
    const work: Category = {
      id: crypto.randomUUID(),
      profileId: id,
      name: "Работа",
      nameNormalized: "работа",
      isSystem: true,
      systemKey: "work",
      createdAt,
    };
    await this.database.createProfileBundle(
      profile,
      [personal, work],
      makeDemonstrationIdea(id, personal.id, now),
    );
    return { id, name };
  }

  async login(profileId: string, pin: string): Promise<ActiveSession> {
    this.loginGuard.assertAllowed(profileId);
    const profile = await this.database.getProfile(profileId);
    if (!profile || !(await verifyPin(pin, profile.pinHash, profile.pinSalt))) {
      this.loginGuard.recordFailure(profileId);
      this.loginGuard.assertAllowed(profileId);
      throw new UserInputError("Неверный PIN-код", "loginPin");
    }
    this.loginGuard.clear(profileId);
    this.activeProfile = profile;
    return { profileId: profile.id, profileName: profile.name };
  }

  logout(): void {
    this.activeProfile = null;
  }

  getCurrentSettings(): ProfileSettings {
    return structuredClone(this.requireSession().settings);
  }

  async updateListSettings(
    patch: Pick<ProfileSettings, "view" | "filters" | "sortBy" | "sortDirection">,
  ): Promise<ProfileSettings> {
    const profile = this.requireSession();
    if (!["cards", "list"].includes(patch.view) ||
      !["returnDate", "priority", "createdAt", "updatedAt"].includes(patch.sortBy) ||
      !["asc", "desc"].includes(patch.sortDirection) || !patch.filters || typeof patch.filters !== "object") {
      throw new UserInputError("Некорректные настройки списка.");
    }
    const settings: ProfileSettings = {
      ...profile.settings,
      view: patch.view,
      filters: structuredClone(patch.filters),
      sortBy: patch.sortBy,
      sortDirection: patch.sortDirection,
    };
    const updated = { ...profile, settings };
    await this.database.saveProfile(updated);
    this.activeProfile = updated;
    return structuredClone(settings);
  }

  async updateTheme(theme: "light" | "dark"): Promise<void> {
    const profile = this.requireSession();
    const updated = { ...profile, settings: { ...profile.settings, theme } };
    await this.database.saveProfile(updated);
    this.activeProfile = updated;
  }

  async updateNotificationSettings(enabled: boolean, notifiedOn?: Record<string, string>): Promise<void> {
    const profile = this.requireSession();
    const updated = {
      ...profile,
      settings: {
        ...profile.settings,
        notificationsEnabled: enabled,
        notifiedOn: notifiedOn ?? profile.settings.notifiedOn ?? {},
      },
    };
    await this.database.saveProfile(updated);
    this.activeProfile = updated;
  }

  async markSuccessfulExport(): Promise<void> {
    const profile = this.requireSession();
    const updated = {
      ...profile,
      lastSuccessfulExportAt: this.now().toISOString(),
      photosSinceExport: 0,
      lastBackupReminderAt: null,
    };
    await this.database.saveProfile(updated);
    this.activeProfile = updated;
  }

  async getBackupReminder(): Promise<"period" | "photos" | null> {
    const session = this.requireSession();
    const profile = await this.database.getProfile(session.id);
    if (!profile) return null;
    this.activeProfile = profile;
    if (profile.lastBackupReminderAt && this.now().getTime() - new Date(profile.lastBackupReminderAt).getTime() < 30 * 24 * 60 * 60 * 1000) return null;
    if (profile.photosSinceExport >= 10) return "photos";
    const basis = profile.lastBackupReminderAt ?? profile.lastSuccessfulExportAt ?? profile.createdAt;
    if (this.now().getTime() - new Date(basis).getTime() >= 30 * 24 * 60 * 60 * 1000) return "period";
    return null;
  }

  async dismissBackupReminder(): Promise<void> {
    const profile = this.requireSession();
    const updated = { ...profile, lastBackupReminderAt: this.now().toISOString() };
    await this.database.saveProfile(updated);
    this.activeProfile = updated;
  }

  async renameProfile(nameInput: string, currentPin: string): Promise<ActiveSession> {
    const profile = await this.requireVerifiedProfile(currentPin);
    const name = validateProfileName(nameInput);
    const nameNormalized = normalizeName(name);
    const duplicate = await this.database.findProfileByNormalizedName(nameNormalized);
    if (duplicate && duplicate.id !== profile.id) {
      throw new UserInputError("Профиль с таким именем уже существует.", "name");
    }
    const updated = { ...profile, name, nameNormalized };
    await this.database.saveProfile(updated);
    this.activeProfile = updated;
    return { profileId: updated.id, profileName: updated.name };
  }

  async changePin(currentPin: string, newPin: string, confirmation: string): Promise<void> {
    const profile = await this.requireVerifiedProfile(currentPin);
    if (!validatePinFormat(newPin)) {
      throw new UserInputError("Новый PIN должен состоять ровно из 4 цифр.", "newPin");
    }
    if (newPin !== confirmation) {
      throw new UserInputError("Новые PIN-коды не совпадают.", "newPinConfirmation");
    }
    const credentials = await hashPin(newPin);
    const updated = { ...profile, ...credentials };
    await this.database.saveProfile(updated);
    this.activeProfile = updated;
  }

  async confirmCurrentPin(pin: string): Promise<void> {
    await this.requireVerifiedProfile(pin);
  }

  async listCategories(): Promise<Category[]> {
    return this.database.listCategories(this.requireSession().id);
  }

  async createCategory(nameInput: string): Promise<Category> {
    const profile = this.requireSession();
    const name = validateCategoryName(nameInput);
    await this.assertCategoryNameAvailable(profile.id, name);
    const category: Category = {
      id: crypto.randomUUID(),
      profileId: profile.id,
      name,
      nameNormalized: normalizeName(name),
      isSystem: false,
      systemKey: null,
      createdAt: this.now().toISOString(),
    };
    await this.database.saveCategory(category);
    return category;
  }

  async renameCategory(categoryId: string, nameInput: string): Promise<Category> {
    const profile = this.requireSession();
    const name = validateCategoryName(nameInput);
    const categories = await this.database.listCategories(profile.id);
    const category = categories.find((item) => item.id === categoryId);
    if (!category) throw new UserInputError("Категория не найдена.");
    await this.assertCategoryNameAvailable(profile.id, name, categoryId);
    const updated = { ...category, name, nameNormalized: normalizeName(name) };
    await this.database.saveCategory(updated);
    return updated;
  }

  async deleteCategory(categoryId: string): Promise<void> {
    const profile = this.requireSession();
    await this.database.deleteCategoryIfUnused(profile.id, categoryId);
  }

  async clearCurrentProfile(pin: string, confirmationWord: string): Promise<void> {
    const profile = await this.requireVerifiedProfile(pin);
    this.assertDeleteWord(confirmationWord);
    await this.database.clearProfileContent(profile.id);
  }

  async deleteCurrentProfile(pin: string, confirmationWord: string): Promise<void> {
    const profile = await this.requireVerifiedProfile(pin);
    this.assertDeleteWord(confirmationWord);
    await this.database.deleteProfileData(profile.id);
    this.loginGuard.clear(profile.id);
    this.activeProfile = null;
  }

  private requireSession(): Profile {
    if (!this.activeProfile) throw new UserInputError("Сначала войдите в профиль.");
    return this.activeProfile;
  }

  private async requireVerifiedProfile(pin: string): Promise<Profile> {
    const profile = this.requireSession();
    if (!(await verifyPin(pin, profile.pinHash, profile.pinSalt))) {
      throw new UserInputError("Неверный PIN-код", "currentPin");
    }
    return profile;
  }

  private assertDeleteWord(value: string): void {
    if (value !== "УДАЛИТЬ") {
      throw new UserInputError("Введите слово УДАЛИТЬ русскими заглавными буквами.", "deleteWord");
    }
  }

  private async assertCategoryNameAvailable(
    profileId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const normalized = normalizeName(name);
    const duplicate = (await this.database.listCategories(profileId)).find(
      (category) => category.nameNormalized === normalized && category.id !== exceptId,
    );
    if (duplicate) {
      throw new UserInputError("Категория с таким названием уже существует.", "categoryName");
    }
  }
}
