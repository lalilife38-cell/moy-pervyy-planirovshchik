import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoginAttemptGuard, LoginBlockedError } from "../src/auth/login-guard";
import { ProfileService, UserInputError } from "../src/application/profile-service";
import { DATABASE_NAME } from "../src/domain/constants";
import { IdeaDatabase } from "../src/storage/database";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const newProfile = (name = "Анна", pin = "1234") => ({
  name,
  pin,
  pinConfirmation: pin,
  recoveryWarningAccepted: true,
});

describe("профили и локальный вход", () => {
  let database: IdeaDatabase;
  let service: ProfileService;

  beforeEach(async () => {
    await deleteDatabase();
    database = await IdeaDatabase.open();
    service = new ProfileService(database, undefined, () => new Date(2026, 7, 18, 12));
  });

  afterEach(() => database.close());

  it("создаёт профиль, две категории и демонстрационную идею без автовхода", async () => {
    const created = await service.createProfile(newProfile("  Анна  "));
    expect(created.name).toBe("Анна");
    expect(service.session).toBeNull();
    expect(await service.listPublicProfiles()).toEqual([{ id: created.id, name: "Анна" }]);

    const stored = await database.getProfile(created.id);
    expect(stored?.pinHash).not.toContain("1234");
    expect(stored?.pinHash).not.toBe("1234");
    expect(stored?.pinSalt).toBeTruthy();
    const categories = await database.listCategories(created.id);
    expect(categories
      .map(({ name, isSystem, systemKey }) => ({ name, isSystem, systemKey }))
      .sort((left, right) => String(left.systemKey).localeCompare(String(right.systemKey)))).toEqual([
      { name: "Личное", isSystem: true, systemKey: "personal" },
      { name: "Работа", isSystem: true, systemKey: "work" },
    ].sort((left, right) => left.systemKey.localeCompare(right.systemKey)));
    const ideas = await database.listIdeas(created.id);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({
      title: "Продумать место для короткой поездки",
      complexity: "complex",
      returnDate: "2026-09-01",
    });
    expect(ideas[0]?.subtasks).toHaveLength(1);
  });

  it("проверяет имя, PIN, повтор и предупреждение", async () => {
    await expect(service.createProfile(newProfile(" "))).rejects.toMatchObject({ field: "name" });
    await expect(service.createProfile({ ...newProfile(), pin: "12a4" })).rejects.toMatchObject({ field: "pin" });
    await expect(service.createProfile({ ...newProfile(), pinConfirmation: "4321" })).rejects.toMatchObject({ field: "pinConfirmation" });
    await expect(service.createProfile({ ...newProfile(), recoveryWarningAccepted: false })).rejects.toMatchObject({ field: "recoveryWarning" });
  });

  it("не допускает совпадающие имена без учёта регистра и крайних пробелов", async () => {
    await service.createProfile(newProfile("Анна"));
    await expect(service.createProfile(newProfile("  АННА  ", "5678"))).rejects.toThrow("уже существует");
    expect(await service.listPublicProfiles()).toHaveLength(1);
  });

  it("не раскрывает профиль по неверному PIN и блокирует пятую попытку на 30 секунд", async () => {
    let clock = 1_000;
    const guard = new LoginAttemptGuard(() => clock);
    service = new ProfileService(database, guard, () => new Date(2026, 7, 18, 12));
    const profile = await service.createProfile(newProfile());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.login(profile.id, "0000")).rejects.toThrow("Неверный PIN-код");
      expect(service.session).toBeNull();
    }
    await expect(service.login(profile.id, "0000")).rejects.toBeInstanceOf(LoginBlockedError);
    await expect(service.login(profile.id, "1234")).rejects.toBeInstanceOf(LoginBlockedError);
    clock += 30_000;
    await expect(service.login(profile.id, "1234")).resolves.toMatchObject({ profileName: "Анна" });
  });

  it("входит только отдельным действием и очищает сессию при выходе", async () => {
    const profile = await service.createProfile(newProfile());
    expect(service.session).toBeNull();
    await service.login(profile.id, "1234");
    expect(service.session?.profileId).toBe(profile.id);
    service.logout();
    expect(service.session).toBeNull();
    await expect(service.listCategories()).rejects.toThrow("Сначала войдите");
  });

  it("меняет имя и PIN только после текущего PIN", async () => {
    const first = await service.createProfile(newProfile("Анна", "1234"));
    await service.createProfile(newProfile("Борис", "5678"));
    await service.login(first.id, "1234");

    await expect(service.renameProfile("Новое имя", "0000")).rejects.toThrow("Неверный PIN-код");
    await expect(service.renameProfile("  БОРИС ", "1234")).rejects.toThrow("уже существует");
    await service.renameProfile("Анна Новая", "1234");
    expect(service.session?.profileName).toBe("Анна Новая");

    await expect(service.changePin("0000", "2222", "2222")).rejects.toThrow("Неверный PIN-код");
    await expect(service.changePin("1234", "2222", "3333")).rejects.toMatchObject({ field: "newPinConfirmation" });
    await service.changePin("1234", "2222", "2222");
    service.logout();
    await expect(service.login(first.id, "1234")).rejects.toThrow("Неверный PIN-код");
    await expect(service.login(first.id, "2222")).resolves.toMatchObject({ profileName: "Анна Новая" });
  });

  it("создаёт и переименовывает категории, но защищает начальные и используемые", async () => {
    const profile = await service.createProfile(newProfile());
    await service.login(profile.id, "1234");
    const initial = await service.listCategories();
    await expect(service.deleteCategory(initial[0]!.id)).rejects.toThrow("нельзя удалить");

    const custom = await service.createCategory(" Фантазия ");
    expect(custom.name).toBe("Фантазия");
    await expect(service.createCategory("фАНТАЗИЯ")).rejects.toThrow("уже существует");
    await service.renameCategory(custom.id, "Путешествия");
    expect((await service.listCategories()).find(({ id }) => id === custom.id)?.name).toBe("Путешествия");

    const idea = (await database.listIdeas(profile.id))[0]!;
    await database.saveIdea({ ...idea, categoryId: custom.id });
    await expect(service.deleteCategory(custom.id)).rejects.toThrow("используется в 1 идеях");
    await database.saveIdea({ ...idea, categoryId: initial[0]!.id });
    await service.deleteCategory(custom.id);
    expect((await service.listCategories()).some(({ id }) => id === custom.id)).toBe(false);
  });

  it("очищает только текущий профиль и сбрасывает его категории", async () => {
    const first = await service.createProfile(newProfile("Анна", "1234"));
    const second = await service.createProfile(newProfile("Борис", "5678"));
    await service.login(first.id, "1234");
    const initial = await service.listCategories();
    await service.renameCategory(initial[0]!.id, "Дом");
    await service.createCategory("Лишняя");

    await expect(service.clearCurrentProfile("1234", "удалить")).rejects.toThrow("УДАЛИТЬ");
    await service.clearCurrentProfile("1234", "УДАЛИТЬ");
    expect(await database.getProfile(first.id)).not.toBeNull();
    expect(await database.listIdeas(first.id)).toEqual([]);
    expect((await database.listCategories(first.id)).map(({ name }) => name).sort()).toEqual(["Личное", "Работа"].sort());
    expect(await database.listIdeas(second.id)).toHaveLength(1);
    expect(await database.listCategories(second.id)).toHaveLength(2);
  });

  it("удаляет только выбранный профиль после усиленного подтверждения", async () => {
    const first = await service.createProfile(newProfile("Анна", "1234"));
    const second = await service.createProfile(newProfile("Борис", "5678"));
    await service.login(first.id, "1234");

    await expect(service.deleteCurrentProfile("0000", "УДАЛИТЬ")).rejects.toThrow("Неверный PIN-код");
    await expect(service.deleteCurrentProfile("1234", "Удалить")).rejects.toThrow("УДАЛИТЬ");
    await service.deleteCurrentProfile("1234", "УДАЛИТЬ");
    expect(service.session).toBeNull();
    expect(await database.getProfile(first.id)).toBeNull();
    expect(await database.getProfile(second.id)).not.toBeNull();
  });

  it("сохраняет вид, фильтры и сортировку отдельно для каждого профиля", async () => {
    const first = await service.createProfile(newProfile("Анна", "1234"));
    const second = await service.createProfile(newProfile("Борис", "5678"));
    await service.login(first.id, "1234");
    await service.updateListSettings({
      view: "list",
      filters: { priority: ["high"], category: ["category-a"] },
      sortBy: "priority",
      sortDirection: "desc",
    });
    service.logout();
    await service.login(second.id, "5678");
    expect(service.getCurrentSettings()).toMatchObject({ view: "cards", filters: {}, sortBy: "returnDate", sortDirection: "asc" });
    service.logout();
    await service.login(first.id, "1234");
    expect(service.getCurrentSettings()).toMatchObject({
      view: "list",
      filters: { priority: ["high"], category: ["category-a"] },
      sortBy: "priority",
      sortDirection: "desc",
    });
  });

  it("сохраняет тему и настройку уведомлений только в текущем профиле", async () => {
    const profile = await service.createProfile(newProfile());
    await service.login(profile.id, "1234");
    await service.updateTheme("dark");
    await service.updateNotificationSettings(true, { "idea-1": "2026-08-18" });
    service.logout();
    await service.login(profile.id, "1234");
    expect(service.getCurrentSettings()).toMatchObject({ theme: "dark", notificationsEnabled: true, notifiedOn: { "idea-1": "2026-08-18" } });
  });

  it("показывает и откладывает напоминание о копии, а успешный экспорт сбрасывает счётчик фото", async () => {
    const profile = await service.createProfile(newProfile());
    await service.login(profile.id, "1234");
    const stored = (await database.getProfile(profile.id))!;
    await database.saveProfile({ ...stored, photosSinceExport: 10 });
    expect(await service.getBackupReminder()).toBe("photos");
    await service.dismissBackupReminder();
    expect(await service.getBackupReminder()).toBeNull();
    await service.markSuccessfulExport();
    expect(await database.getProfile(profile.id)).toMatchObject({ photosSinceExport: 0, lastSuccessfulExportAt: "2026-08-18T09:00:00.000Z" });
  });

  it("возвращает понятную ошибку без технического стека для неавторизованного действия", async () => {
    await expect(service.createCategory("Тест")).rejects.toBeInstanceOf(UserInputError);
  });
});
