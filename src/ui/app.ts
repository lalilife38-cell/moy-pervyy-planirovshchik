import { LoginBlockedError } from "../auth/login-guard";
import { ProfileService, UserInputError, type PublicProfile } from "../application/profile-service";
import { BackupService, type BackupEnvelope } from "../application/backup-service";
import { NotificationService } from "../application/notification-service";
import { TechnicalReportService } from "../application/technical-report-service";
import { ALLOWED_STATUS_TRANSITIONS, IdeaService, subtaskProgress } from "../application/idea-service";
import {
  EMPTY_FILTERS,
  SECTION_LABELS,
  STATUS_LABELS,
  filtersFromSettings,
  filtersToSettings,
  hasActiveFilters,
  isOverdue,
  sectionCounts,
  selectIdeas,
  type IdeaFilters,
  type IdeaSection,
} from "../application/idea-list-service";
import { BACKUP_LIMITS, THEME_FLAG_KEY, WELCOME_FLAG_KEY } from "../domain/constants";
import { formatCalendarDate, toLocalCalendarDate } from "../domain/dates";
import type { Category, Idea, ProfileSettings } from "../domain/types";
import { IdeaDatabase } from "../storage/database";
import { explainStorageError } from "../storage/errors";
import { PwaController } from "../pwa";
import { IdeaUi } from "./idea-ui";

type DialogSetup = (dialog: HTMLDialogElement) => void;

export class Application {
  private readonly service: ProfileService;
  private readonly ideaService: IdeaService;
  private readonly ideaUi: IdeaUi;
  private readonly backupService: BackupService;
  private readonly notificationService: NotificationService;
  private readonly reportService: TechnicalReportService;
  private activeDialog: HTMLDialogElement | null = null;
  private ideaView: IdeaSection = "today";
  private ideaQuery = "";
  private searchTimer: number | null = null;
  private dayTimer: number | null = null;
  private renderedDay = "";
  private notificationTimer: number | null = null;

  constructor(
    private readonly root: HTMLDivElement,
    private readonly database: IdeaDatabase,
    private readonly pwa: PwaController,
  ) {
    this.service = new ProfileService(database);
    this.ideaService = new IdeaService(database, () => this.service.session?.profileId ?? null);
    this.ideaUi = new IdeaUi(
      this.ideaService,
      () => this.service.listCategories(),
      () => this.renderToday(),
    );
    this.backupService = new BackupService(database, () => this.service.session?.profileId ?? null);
    this.notificationService = new NotificationService(this.service, (ideaId) => {
      if (this.service.session) void this.ideaUi.openDetails(this.root, ideaId);
    });
    this.reportService = new TechnicalReportService(database);
  }

  start(): void {
    this.applyTheme(localStorage.getItem(THEME_FLAG_KEY) === "dark" ? "dark" : "light");
    if (localStorage.getItem(WELCOME_FLAG_KEY) === "1") {
      void this.renderProfiles();
    } else {
      this.renderWelcome();
    }
  }

  destroy(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    if (this.dayTimer !== null) window.clearInterval(this.dayTimer);
    if (this.notificationTimer !== null) window.clearInterval(this.notificationTimer);
    this.activeDialog?.close();
    this.service.logout();
    this.database.close();
  }

  private renderWelcome(): void {
    this.root.innerHTML = `
      <main class="welcome-screen">
        <section class="welcome-card" aria-labelledby="welcome-title">
          <div class="brand-mark" aria-hidden="true">ВИ</div>
          <p class="eyebrow">Локальный планировщик</p>
          <h1 id="welcome-title">Дайте идеям время</h1>
          <p class="welcome-copy">Сохраняйте замыслы, назначайте день возвращения и постепенно превращайте большие идеи в понятные шаги.</p>
          <div class="video-placeholder" aria-label="Место для будущего знакомства с приложением">
            <span aria-hidden="true">▶</span>
            <p>Здесь появится короткое знакомство с приложением</p>
          </div>
          <button class="button button--primary button--wide" type="button" data-action="continue">Продолжить</button>
          <button class="text-button button--wide" type="button" data-install-help>Как установить приложение</button>
          <p class="privacy-note">Все данные останутся только в этом браузере.</p>
        </section>
      </main>
    `;
    this.root.querySelector<HTMLButtonElement>("[data-action='continue']")?.addEventListener("click", () => {
      localStorage.setItem(WELCOME_FLAG_KEY, "1");
      void this.renderProfiles();
    });
    this.bindInstallHelp();
  }

  private async renderProfiles(message?: string): Promise<void> {
    const profiles = await this.service.listPublicProfiles();
    this.root.innerHTML = `
      <main class="profiles-screen">
        <section class="profiles-card" aria-labelledby="profiles-title">
          <header class="profiles-header">
            <div class="brand-mark brand-mark--small" aria-hidden="true">ВИ</div>
            <div>
              <p class="eyebrow">Время идеи</p>
              <h1 id="profiles-title">Выберите профиль</h1>
            </div>
          </header>
          <p class="section-copy">Каждый профиль хранится отдельно. Для входа понадобится ваш четырёхзначный PIN.</p>
          <div class="notice notice--success" role="status" aria-live="polite" ${message ? "" : "hidden"}></div>
          <div class="profile-list" aria-label="Локальные профили"></div>
          <div class="empty-state" ${profiles.length ? "hidden" : ""}>
            <p>Профилей пока нет</p>
            <span>Создайте первый профиль, чтобы начать.</span>
          </div>
          <button class="button button--primary button--wide" type="button" data-action="create-profile">Создать профиль</button>
          <button class="button button--secondary button--wide" type="button" data-action="import-profile">Импортировать резервную копию</button>
          <button class="text-button button--wide" type="button" data-install-help>Как установить приложение</button>
          <p class="local-warning">Очистка данных сайта удалит локальные профили без возможности восстановления.</p>
        </section>
      </main>
    `;
    const notice = this.root.querySelector<HTMLElement>(".notice");
    if (notice && message) notice.textContent = message;
    const list = this.root.querySelector<HTMLElement>(".profile-list");
    for (const profile of profiles) list?.append(this.makeProfileButton(profile));
    this.root.querySelector<HTMLButtonElement>("[data-action='create-profile']")?.addEventListener(
      "click",
      (event) => this.openCreateProfileDialog(event.currentTarget as HTMLButtonElement),
    );
    this.root.querySelector<HTMLButtonElement>("[data-action='import-profile']")?.addEventListener(
      "click",
      (event) => this.openImportDialog(event.currentTarget as HTMLButtonElement),
    );
    this.bindInstallHelp();
  }

  private makeProfileButton(profile: PublicProfile): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile-button";
    button.dataset.profileId = profile.id;
    const avatar = document.createElement("span");
    avatar.className = "profile-initial";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = profile.name.trim().slice(0, 1).toLocaleUpperCase("ru-RU");
    const name = document.createElement("span");
    name.textContent = profile.name;
    const arrow = document.createElement("span");
    arrow.className = "profile-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    button.append(avatar, name, arrow);
    button.addEventListener("click", () => this.openLoginDialog(profile, button));
    return button;
  }

  private openCreateProfileDialog(trigger: HTMLElement): void {
    this.openDialog(
      trigger,
      `
        <div class="dialog-heading">
          <p class="eyebrow">Новый профиль</p>
          <h2>Создание профиля</h2>
          <button class="icon-button" type="button" data-close aria-label="Закрыть">×</button>
        </div>
        <p class="dialog-copy">Профиль и все идеи будут храниться только в этом браузере.</p>
        <form class="stack-form" novalidate>
          <div class="error-summary" role="alert" hidden></div>
          <label class="field">
            <span>Имя профиля</span>
            <input name="name" maxlength="40" autocomplete="off" required />
          </label>
          <div class="field-grid">
            <label class="field">
              <span>PIN-код</span>
              <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required />
            </label>
            <label class="field">
              <span>Повторите PIN</span>
              <input name="pinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required />
            </label>
          </div>
          <label class="check-field">
            <input name="recoveryWarning" type="checkbox" />
            <span>Я понимаю, что забытый PIN нельзя восстановить: у приложения нет сервера и электронной почты.</span>
          </label>
          <div class="notice"><strong>Важно:</strong> очистка данных сайта или удаление браузера безвозвратно удалит профиль. Делайте ручные резервные копии.</div>
          <button class="button button--primary button--wide" type="submit">Создать профиль</button>
        </form>
      `,
      (dialog) => {
        const form = dialog.querySelector<HTMLFormElement>("form");
        form?.addEventListener("submit", async (event) => {
          event.preventDefault();
          const data = new FormData(form);
          this.setFormBusy(form, true);
          try {
            const profile = await this.service.createProfile({
              name: String(data.get("name") ?? ""),
              pin: String(data.get("pin") ?? ""),
              pinConfirmation: String(data.get("pinConfirmation") ?? ""),
              recoveryWarningAccepted: data.get("recoveryWarning") === "on",
            });
            this.closeDialog();
            await this.renderProfiles(`Профиль «${profile.name}» создан. Теперь войдите с PIN-кодом.`);
          } catch (error) {
            this.showFormError(form, error);
          } finally {
            this.setFormBusy(form, false);
          }
        });
      },
    );
  }

  private openLoginDialog(profile: PublicProfile, trigger: HTMLElement): void {
    this.openDialog(
      trigger,
      `
        <div class="dialog-heading dialog-heading--centered">
          <button class="icon-button icon-button--back" type="button" data-close aria-label="Назад">←</button>
          <div>
            <p class="eyebrow">Вход в профиль</p>
            <h2 data-profile-name></h2>
          </div>
        </div>
        <form class="stack-form" novalidate>
          <div class="error-summary" role="alert" hidden></div>
          <label class="field field--centered">
            <span>Введите PIN-код</span>
            <input class="pin-input" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" aria-describedby="pin-hint" autofocus required />
          </label>
          <p class="field-hint" id="pin-hint">Ровно 4 цифры</p>
          <button class="button button--primary button--wide" type="submit">Войти</button>
          <p class="no-recovery">Восстановления забытого PIN нет.</p>
        </form>
      `,
      (dialog) => {
        const profileName = dialog.querySelector<HTMLElement>("[data-profile-name]");
        if (profileName) profileName.textContent = profile.name;
        const form = dialog.querySelector<HTMLFormElement>("form");
        form?.addEventListener("submit", async (event) => {
          event.preventDefault();
          const pin = String(new FormData(form).get("pin") ?? "");
          this.setFormBusy(form, true);
          try {
            await this.service.login(profile.id, pin);
            this.closeDialog();
            this.applyTheme(this.service.getCurrentSettings().theme);
            this.ideaView = "today";
            this.ideaQuery = "";
            void this.renderToday();
          } catch (error) {
            if (error instanceof LoginBlockedError) {
              this.startLoginCountdown(form, profile.id, error.remainingSeconds);
            }
            this.showFormError(form, error);
          } finally {
            if (!form.dataset.blocked) this.setFormBusy(form, false);
          }
        });
      },
    );
  }

  private startLoginCountdown(form: HTMLFormElement, _profileId: string, seconds: number): void {
    form.dataset.blocked = "true";
    const input = form.querySelector<HTMLInputElement>("input[name='pin']");
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    let remaining = seconds;
    const summary = form.querySelector<HTMLElement>(".error-summary");
    const update = (): void => {
      if (summary) summary.textContent = `Слишком много попыток. Повторите через ${remaining} сек.`;
      if (remaining <= 0) {
        window.clearInterval(timer);
        delete form.dataset.blocked;
        if (input) {
          input.disabled = false;
          input.value = "";
          input.focus();
        }
        if (button) button.disabled = false;
        if (summary) summary.textContent = "Можно попробовать снова.";
        return;
      }
      remaining -= 1;
    };
    update();
    const timer = window.setInterval(update, 1_000);
    this.activeDialog?.addEventListener("close", () => window.clearInterval(timer), { once: true });
  }

  private async renderToday(): Promise<void> {
    const session = this.service.session;
    if (!session) {
      void this.renderProfiles();
      return;
    }
    await this.ideaService.refreshDueIdeas();
    const [ideas, categories] = await Promise.all([
      this.ideaService.listIdeas(),
      this.service.listCategories(),
    ]);
    const today = toLocalCalendarDate();
    this.renderedDay = today;
    this.ensureDayWatcher();
    let settings = this.service.getCurrentSettings();
    this.applyTheme(settings.theme);
    const backupReminder = await this.service.getBackupReminder();
    void this.notificationService.checkDueIdeas(ideas);
    this.ensureNotificationWatcher();
    let filters = filtersFromSettings(settings.filters);
    const counts = sectionCounts(ideas, today);
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <div class="brand-lockup">
            <div class="brand-mark brand-mark--small" aria-hidden="true">ВИ</div>
            <span>Время идеи</span>
          </div>
          <div class="header-actions">
            <span class="active-profile" data-active-profile></span>
            <button class="theme-toggle" type="button" data-theme-toggle aria-label="Переключить тему" aria-pressed="${settings.theme === "dark"}">${settings.theme === "dark" ? "Светлая" : "Тёмная"}</button>
            <button class="icon-button menu-button" type="button" aria-label="Открыть общее меню" aria-expanded="false">•••</button>
          </div>
          <nav class="app-menu" aria-label="Общее меню" hidden>
            <button type="button" data-menu="upcoming">Ближайшие идеи</button>
            <button type="button" data-menu="postponed">Отложенные идеи</button>
            <hr />
            <button type="button" data-menu="categories">Категории</button>
            <button type="button" data-menu="notifications">Уведомления</button>
            <button type="button" data-menu="backup">Импорт и экспорт</button>
            <button type="button" data-menu="diagnostics">Технический отчёт</button>
            <button type="button" data-menu="about">О приложении</button>
            <button type="button" data-menu="rename">Изменить имя</button>
            <button type="button" data-menu="pin">Изменить PIN</button>
            <button type="button" data-menu="clear">Очистить профиль</button>
            <button type="button" data-menu="delete" class="danger-text">Удалить профиль</button>
            <hr />
            <button type="button" data-menu="logout">Выйти</button>
          </nav>
        </header>
        <main class="today-page ideas-workspace">
          <aside class="backup-reminder" ${backupReminder ? "" : "hidden"}>
            <div><strong>${backupReminder === "photos" ? "Добавлено 10 фотографий" : "Пора сохранить резервную копию"}</strong><p>${backupReminder === "photos" ? "Экспорт защитит новые фотографии от потери при очистке браузера." : "Локальные данные можно потерять при очистке браузера. Автоматической копии нет."}</p></div>
            <button class="button button--secondary button--small" type="button" data-reminder-export>Экспортировать</button><button class="text-button" type="button" data-reminder-dismiss>Напомнить через 30 дней</button>
          </aside>
          <div class="ideas-page-heading">
            <div><p class="eyebrow">Ваш план</p><h1>${SECTION_LABELS[this.ideaView]}</h1></div>
            <button class="button button--primary" type="button" data-add-idea>Добавить идею</button>
          </div>
          <nav class="idea-view-tabs section-tabs" aria-label="Разделы идей"></nav>
          <section class="list-tools" aria-label="Поиск, фильтры и сортировка">
            <label class="search-field"><span class="visually-hidden">Поиск по названию и описанию</span><input type="search" data-search placeholder="Найти идею" autocomplete="off" /></label>
            <div class="view-switch" aria-label="Вид списка">
              <button type="button" data-list-view="cards" aria-pressed="${settings.view === "cards"}">Карточки</button>
              <button type="button" data-list-view="list" aria-pressed="${settings.view === "list"}">Список</button>
            </div>
            <label class="compact-field"><span>Сортировка</span><select data-sort>
              <option value="returnDate">По дате возвращения</option><option value="priority">По приоритету</option><option value="createdAt">По дате создания</option><option value="updatedAt">По изменению</option>
            </select></label>
            <button class="icon-button sort-direction" type="button" data-sort-direction aria-label="Сменить направление сортировки"></button>
            <details class="filter-panel"><summary>Фильтры <span data-filter-badge></span></summary><div class="filter-content"></div></details>
          </section>
          <p class="result-count" role="status" aria-live="polite"></p>
          <section class="today-empty" aria-labelledby="today-empty-title" hidden>
            <div class="sun-icon" aria-hidden="true">☼</div><h2 id="today-empty-title"></h2><p data-empty-copy></p>
          </section>
          <section class="idea-card-list" aria-label="Идеи"></section>
        </main>
        <nav class="mobile-navigation" aria-label="Основная навигация">
          <button type="button" data-view="today">Сегодня <span>${counts.today}</span></button>
          <button type="button" data-view="all">Все <span>${counts.all}</span></button>
          <button class="mobile-add" type="button" data-add-idea aria-label="Добавить идею">+</button>
          <button type="button" data-view="inProgress">В работе <span>${counts.inProgress}</span></button>
          <button type="button" data-view="archive">Архив <span>${counts.archive}</span></button>
        </nav>
        <div class="toast-region" aria-live="polite" aria-atomic="true"></div>
      </div>
    `;
    const name = this.root.querySelector<HTMLElement>("[data-active-profile]");
    if (name) name.textContent = session.profileName;
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    this.root.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const theme = settings.theme === "dark" ? "light" : "dark";
      await this.service.updateTheme(theme);
      settings.theme = theme;
      this.applyTheme(theme);
      button.textContent = theme === "dark" ? "Светлая" : "Тёмная";
      button.setAttribute("aria-pressed", String(theme === "dark"));
    });
    this.root.querySelector<HTMLButtonElement>("[data-reminder-export]")?.addEventListener("click", (event) => this.openBackupDialog(event.currentTarget as HTMLElement));
    this.root.querySelector<HTMLButtonElement>("[data-reminder-dismiss]")?.addEventListener("click", async () => {
      await this.service.dismissBackupReminder();
      this.root.querySelector<HTMLElement>(".backup-reminder")?.setAttribute("hidden", "");
    });
    const tabs = this.root.querySelector<HTMLElement>(".section-tabs");
    for (const section of ["today", "upcoming", "all", "postponed", "inProgress", "archive"] as IdeaSection[]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.view = section;
      button.setAttribute("aria-current", this.ideaView === section ? "page" : "false");
      button.textContent = `${SECTION_LABELS[section]} ${counts[section]}`;
      tabs?.append(button);
    }
    const renderFilters = (): void => {
      const content = this.root.querySelector<HTMLElement>(".filter-content");
      if (!content) return;
      content.replaceChildren(
        this.makeFilterGroup("Категория", "category", categories.map((item) => [item.id, item.name]), filters.category),
        this.makeFilterGroup("Приоритет", "priority", [["low", "Низкий"], ["medium", "Средний"], ["high", "Высокий"]], filters.priority),
        this.makeFilterGroup("Сложность", "complexity", [["simple", "Простая"], ["complex", "Сложная"]], filters.complexity),
        this.makeFilterGroup("Статус", "status", Object.entries(STATUS_LABELS), filters.status),
        this.makeFilterGroup("Срок", "due", [["withoutDate", "Без даты"], ["overdue", "Просроченные"], ["today", "Сегодня"], ["upcoming", "Ближайшие 7 дней"], ["later", "Позже"]], filters.due),
      );
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "text-button filter-reset";
      reset.textContent = "Сбросить фильтры";
      reset.addEventListener("click", async () => {
        filters = filtersFromSettings(filtersToSettings(EMPTY_FILTERS));
        await persistSettings();
        renderFilters();
        renderResults();
      });
      content.append(reset);
    };
    const renderResults = (): void => {
      const selected = selectIdeas(ideas, {
        section: this.ideaView,
        query: this.ideaQuery,
        filters,
        sortBy: settings.sortBy,
        sortDirection: settings.sortDirection,
        today,
      });
      const list = this.root.querySelector<HTMLElement>(".idea-card-list");
      list?.replaceChildren();
      list?.classList.toggle("idea-card-list--compact", settings.view === "list");
      for (const idea of selected) {
        list?.append(this.makeIdeaCard(idea, categoryNames.get(idea.categoryId) ?? "Без категории", settings.view, today));
      }
      const count = this.root.querySelector<HTMLElement>(".result-count");
      if (count) count.textContent = `Найдено: ${selected.length}`;
      const empty = this.root.querySelector<HTMLElement>(".today-empty");
      if (empty) empty.hidden = selected.length > 0;
      const title = this.root.querySelector<HTMLElement>("#today-empty-title");
      const copy = this.root.querySelector<HTMLElement>("[data-empty-copy]");
      const narrowed = Boolean(this.ideaQuery.trim()) || hasActiveFilters(filters);
      if (title) title.textContent = narrowed ? "Ничего не найдено" : this.emptyTitle(this.ideaView);
      if (copy) copy.textContent = narrowed ? "Измените запрос или сбросьте фильтры." : this.emptyCopy(this.ideaView);
      const badge = this.root.querySelector<HTMLElement>("[data-filter-badge]");
      if (badge) badge.textContent = hasActiveFilters(filters) ? "активны" : "";
    };
    const persistSettings = async (): Promise<void> => {
      settings = await this.service.updateListSettings({
        view: settings.view,
        filters: filtersToSettings(filters),
        sortBy: settings.sortBy,
        sortDirection: settings.sortDirection,
      });
    };
    this.root.querySelectorAll<HTMLButtonElement>("[data-add-idea]").forEach((button) => button.addEventListener("click", (event) =>
      void this.ideaUi.openCreate(event.currentTarget as HTMLElement),
    ));
    this.root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => {
      this.ideaView = button.dataset.view as IdeaSection;
      this.ideaQuery = "";
      void this.renderToday();
    }));
    const search = this.root.querySelector<HTMLInputElement>("[data-search]");
    if (search) search.value = this.ideaQuery;
    search?.addEventListener("input", () => {
      this.ideaQuery = search.value;
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(renderResults, 150);
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-list-view]").forEach((button) => button.addEventListener("click", async () => {
      settings.view = button.dataset.listView === "list" ? "list" : "cards";
      await persistSettings();
      this.root.querySelectorAll<HTMLButtonElement>("[data-list-view]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.listView === settings.view)));
      renderResults();
    }));
    const sort = this.root.querySelector<HTMLSelectElement>("[data-sort]");
    if (sort) sort.value = settings.sortBy;
    sort?.addEventListener("change", async () => {
      settings.sortBy = sort.value as ProfileSettings["sortBy"];
      await persistSettings();
      renderResults();
    });
    const direction = this.root.querySelector<HTMLButtonElement>("[data-sort-direction]");
    const updateDirection = (): void => {
      if (!direction) return;
      direction.textContent = settings.sortDirection === "asc" ? "↑" : "↓";
      direction.title = settings.sortDirection === "asc" ? "Прямой порядок" : "Обратный порядок";
    };
    direction?.addEventListener("click", async () => {
      settings.sortDirection = settings.sortDirection === "asc" ? "desc" : "asc";
      await persistSettings();
      updateDirection();
      renderResults();
    });
    this.root.querySelector<HTMLElement>(".filter-content")?.addEventListener("change", async (event) => {
      const input = event.target as HTMLInputElement;
      const group = input.dataset.filterGroup as keyof IdeaFilters | undefined;
      if (!group) return;
      const values = Array.from(this.root.querySelectorAll<HTMLInputElement>(`[data-filter-group='${group}']:checked`)).map((item) => item.value);
      (filters[group] as string[]) = values;
      await persistSettings();
      renderResults();
    });
    renderFilters();
    updateDirection();
    renderResults();
    const menuButton = this.root.querySelector<HTMLButtonElement>(".menu-button");
    const menu = this.root.querySelector<HTMLElement>(".app-menu");
    menuButton?.addEventListener("click", () => {
      const willOpen = Boolean(menu?.hidden);
      if (menu) menu.hidden = !willOpen;
      menuButton.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) menu?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    menu?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-menu]");
      if (!button) return;
      menu.hidden = true;
      menuButton?.setAttribute("aria-expanded", "false");
      const action = button.dataset.menu;
      if (action === "upcoming" || action === "postponed") {
        this.ideaView = action;
        this.ideaQuery = "";
        void this.renderToday();
      } else if (action === "logout") {
        if (this.dayTimer !== null) window.clearInterval(this.dayTimer);
        this.dayTimer = null;
        if (this.notificationTimer !== null) window.clearInterval(this.notificationTimer);
        this.notificationTimer = null;
        this.service.logout();
        void this.renderProfiles();
      } else if (action === "categories") {
        this.openCategoriesDialog(menuButton ?? button);
      } else if (action === "notifications") {
        this.openNotificationsDialog(menuButton ?? button);
      } else if (action === "backup") {
        this.openBackupDialog(menuButton ?? button);
      } else if (action === "diagnostics") {
        this.openDiagnosticsDialog(menuButton ?? button);
      } else if (action === "about") {
        this.openAboutDialog(menuButton ?? button);
      } else if (action === "rename") {
        this.openRenameProfileDialog(menuButton ?? button);
      } else if (action === "pin") {
        this.openChangePinDialog(menuButton ?? button);
      } else if (action === "clear") {
        this.openDangerDialog(menuButton ?? button, "clear");
      } else if (action === "delete") {
        this.openDangerDialog(menuButton ?? button, "delete");
      }
    });
  }

  private makeIdeaCard(idea: Idea, categoryName: string, view: "cards" | "list", today: string): HTMLElement {
    const card = document.createElement("article");
    card.className = `idea-card${view === "list" ? " idea-card--compact" : ""}${isOverdue(idea, today) ? " idea-card--overdue" : ""}`;
    const main = document.createElement("button");
    main.type = "button";
    main.className = "idea-card-main";
    const heading = document.createElement("div");
    heading.className = "idea-card-heading";
    const title = document.createElement("h2");
    title.textContent = idea.title;
    const priority = document.createElement("span");
    priority.className = `priority priority--${idea.priority}`;
    priority.textContent = idea.priority === "high" ? "Высокий" : idea.priority === "low" ? "Низкий" : "Средний";
    const status = document.createElement("span");
    status.className = `status-badge status-badge--${idea.status}`;
    status.textContent = STATUS_LABELS[idea.status];
    heading.append(title, status, priority);
    const description = document.createElement("p");
    description.textContent = idea.description;
    const meta = document.createElement("div");
    meta.className = "idea-card-meta";
    const progress = subtaskProgress(idea);
    const values = [
      categoryName,
      idea.complexity === "complex" ? "Сложная" : "Простая",
      idea.returnDate ? formatCalendarDate(idea.returnDate) : "Дата не назначена",
      isOverdue(idea, today) ? "Просрочено" : null,
      progress.total ? `${progress.completed}/${progress.total} шагов` : null,
      idea.hasImage ? "Есть фото" : null,
      idea.sourceIdeaId || idea.sourceWasDeleted ? "Связанная идея" : null,
    ].filter((value): value is string => Boolean(value));
    for (const value of values) {
      const item = document.createElement("span");
      item.textContent = value;
      meta.append(item);
    }
    main.append(heading);
    if (view === "cards") main.append(description);
    main.append(meta);
    main.addEventListener("click", () => void this.ideaUi.openDetails(main, idea.id));
    const actions = document.createElement("div");
    actions.className = "idea-quick-actions";
    const addAction = (label: string, handler: (button: HTMLButtonElement) => void, primary = false): void => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = primary ? "text-button text-button--primary" : "text-button";
      button.textContent = label;
      button.addEventListener("click", () => handler(button));
      actions.append(button);
    };
    if (!["completed", "rejected"].includes(idea.status)) {
      if (ALLOWED_STATUS_TRANSITIONS[idea.status].includes("inProgress")) addAction("Начать", () => void this.ideaService.transitionIdea(idea.id, "inProgress").then(() => this.renderToday()), true);
      if (ALLOWED_STATUS_TRANSITIONS[idea.status].includes("postponed")) addAction("Отложить", (button) => void this.ideaUi.openPostpone(button, idea.id));
      if (idea.complexity === "simple" && idea.returnDate && idea.returnDate <= today && ALLOWED_STATUS_TRANSITIONS[idea.status].includes("postponed")) {
        addAction("Ещё 4 недели", () => void this.ideaService.repeatInFourWeeks(idea.id).then(() => this.renderToday()));
      }
      if (ALLOWED_STATUS_TRANSITIONS[idea.status].includes("completed")) addAction("Выполнить", () => {
        if (window.confirm("Отметить идею выполненной?")) void this.ideaService.transitionIdea(idea.id, "completed").then(() => this.renderToday());
      });
    }
    addAction("Ещё", (button) => void this.ideaUi.openDetails(button, idea.id));
    card.append(main, actions);
    return card;
  }

  private makeFilterGroup(label: string, group: string, options: Array<[string, string]>, selected: readonly string[]): HTMLElement {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = label;
    fieldset.append(legend);
    for (const [value, text] of options) {
      const item = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = value;
      input.dataset.filterGroup = group;
      input.checked = selected.includes(value);
      item.append(input, document.createTextNode(text));
      fieldset.append(item);
    }
    return fieldset;
  }

  private emptyTitle(section: IdeaSection): string {
    if (section === "today") return "На сегодня всё спокойно";
    if (section === "archive") return "Архив пока пуст";
    return `В разделе «${SECTION_LABELS[section]}» пока нет идей`;
  }

  private emptyCopy(section: IdeaSection): string {
    if (section === "today") return "Идеи с сегодняшней или прошедшей датой появятся здесь.";
    if (section === "archive") return "Выполненные и отклонённые идеи появятся здесь.";
    return "Измените раздел или добавьте новую идею.";
  }

  private ensureDayWatcher(): void {
    if (this.dayTimer !== null) return;
    this.dayTimer = window.setInterval(() => {
      if (this.service.session && toLocalCalendarDate() !== this.renderedDay) void this.renderToday();
    }, 30_000);
  }

  private ensureNotificationWatcher(): void {
    if (this.notificationTimer !== null) return;
    this.notificationTimer = window.setInterval(async () => {
      if (this.service.session) await this.notificationService.checkDueIdeas(await this.ideaService.listIdeas());
    }, 60_000);
  }

  private applyTheme(theme: "light" | "dark"): void {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_FLAG_KEY, theme);
  }

  private downloadText(text: string, filename: string, type = "application/json"): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private openNotificationsDialog(trigger: HTMLElement): void {
    this.openDialog(trigger, `
      <div class="dialog-heading"><div><p class="eyebrow">Локальные напоминания</p><h2>Уведомления</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
      <div class="notice" role="status"></div>
      <p class="dialog-copy">Уведомления проверяются около 09:00 по местному времени и при первом открытии после 09:00. Без push-сервера доставка при полностью закрытом браузере не гарантируется, особенно на iOS.</p>
      <div class="dialog-actions"><button class="button button--primary" type="button" data-enable-notifications>Включить уведомления</button><button class="button button--secondary" type="button" data-test-notification>Проверить уведомление</button><button class="text-button" type="button" data-disable-notifications>Выключить</button></div>
    `, (dialog) => {
      const notice = dialog.querySelector<HTMLElement>(".notice")!;
      const refresh = (): void => {
        const enabled = this.service.getCurrentSettings().notificationsEnabled;
        notice.textContent = !this.notificationService.supported
          ? "Уведомления не поддерживаются этим браузером. Идеи всё равно будут видны в разделе «Сегодня»."
          : this.notificationService.permission === "denied"
            ? "Браузер запретил уведомления. Разрешение можно изменить в настройках сайта браузера."
            : enabled ? "Уведомления включены для этого профиля." : "Уведомления выключены.";
        const test = dialog.querySelector<HTMLButtonElement>("[data-test-notification]");
        if (test) test.disabled = this.notificationService.permission !== "granted";
      };
      dialog.querySelector<HTMLButtonElement>("[data-enable-notifications]")?.addEventListener("click", async () => {
        try {
          const permission = await this.notificationService.enable();
          notice.textContent = permission === "granted" ? "Разрешение получено. Можно выполнить тест." : "Разрешение не выдано. Проверьте настройки сайта в браузере.";
          refresh();
        } catch (error) { notice.textContent = this.errorMessage(error); }
      });
      dialog.querySelector<HTMLButtonElement>("[data-test-notification]")?.addEventListener("click", () => {
        try { this.notificationService.showTest(); notice.textContent = "Тест отправлен. Это не гарантирует фоновую доставку при закрытом браузере."; }
        catch (error) { notice.textContent = this.errorMessage(error); }
      });
      dialog.querySelector<HTMLButtonElement>("[data-disable-notifications]")?.addEventListener("click", async () => {
        await this.notificationService.disable();
        refresh();
      });
      refresh();
    });
  }

  private openBackupDialog(trigger: HTMLElement): void {
    this.openDialog(trigger, `
      <div class="dialog-heading"><div><p class="eyebrow">Локальная копия</p><h2>Импорт и экспорт</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
      <p class="dialog-copy">JSON-файл не защищён паролем. PIN-хеш в копию не включается; при импорте задаётся новый PIN.</p>
      <form class="stack-form backup-export-form">
        <div class="notice" role="status">Оцениваем размер…</div>
        <label class="check-row"><input name="photos" type="checkbox" checked /> Включить фотографии</label>
        <progress max="1" value="0" hidden></progress>
        <div class="dialog-actions"><button class="button button--primary" type="submit">Скачать резервную копию</button><button class="text-button" type="button" data-cancel-export hidden>Отменить</button></div>
      </form>
      <hr class="dialog-divider" />
      <button class="button button--secondary button--wide" type="button" data-import-here>Импортировать JSON</button>
      <input type="file" accept="application/json,.json" data-import-file hidden />
    `, (dialog) => {
      const form = dialog.querySelector<HTMLFormElement>(".backup-export-form")!;
      const notice = form.querySelector<HTMLElement>(".notice")!;
      const photos = form.elements.namedItem("photos") as HTMLInputElement;
      void this.backupService.estimateCurrentExport().then((estimate) => {
        notice.textContent = `Примерный размер: ${this.formatBytes(estimate.estimatedBytes)}; фотографий: ${estimate.imageCount}.` +
          (estimate.requiresWarning ? " Большая копия может формироваться дольше." : "");
        if (estimate.exceedsMaximumWithPhotos) {
          photos.checked = false;
          photos.disabled = true;
          notice.textContent += " Экспорт с фотографиями превышает 40 МБ и отключён.";
        }
      }).catch((error) => { notice.textContent = this.errorMessage(error); });
      let controller: AbortController | null = null;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        controller = new AbortController();
        const progress = form.querySelector<HTMLProgressElement>("progress")!;
        const cancel = form.querySelector<HTMLButtonElement>("[data-cancel-export]")!;
        progress.hidden = false;
        cancel.hidden = false;
        try {
          const result = await this.backupService.exportCurrentProfile(photos.checked, (done, total) => {
            progress.max = Math.max(1, total); progress.value = done;
            notice.textContent = total ? `Обработано фотографий: ${done} из ${total}.` : "Формируем JSON…";
          }, controller.signal);
          this.downloadText(result.text, result.filename);
          await this.service.markSuccessfulExport();
          notice.textContent = result.envelope.report.omittedImages
            ? `Копия скачана без ${result.envelope.report.omittedImages} фотографий.` : "Резервная копия скачана.";
        } catch (error) { notice.textContent = error instanceof DOMException && error.name === "AbortError" ? "Экспорт отменён. Данные не изменены." : this.errorMessage(error); }
        finally { cancel.hidden = true; controller = null; }
      });
      form.querySelector<HTMLButtonElement>("[data-cancel-export]")?.addEventListener("click", () => controller?.abort());
      const file = dialog.querySelector<HTMLInputElement>("[data-import-file]")!;
      dialog.querySelector<HTMLButtonElement>("[data-import-here]")?.addEventListener("click", () => file.click());
      file.addEventListener("change", () => { if (file.files?.[0]) void this.readImportFile(dialog, file.files[0]); });
    }, { wide: true });
  }

  private openImportDialog(trigger: HTMLElement): void {
    this.openDialog(trigger, `
      <div class="dialog-heading"><div><p class="eyebrow">Перенос данных</p><h2>Импорт резервной копии</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
      <p class="dialog-copy">Выберите JSON-файл «Время идеи» размером не более 50 МБ. Существующие профили не объединяются автоматически.</p>
      <label class="file-drop"><input type="file" accept="application/json,.json" />Выбрать JSON-файл</label><div class="error-summary" role="alert" hidden></div>
    `, (dialog) => {
      const file = dialog.querySelector<HTMLInputElement>("input[type='file']")!;
      file.addEventListener("change", () => { if (file.files?.[0]) void this.readImportFile(dialog, file.files[0]); });
    }, { wide: true });
  }

  private async readImportFile(dialog: HTMLDialogElement, file: File): Promise<void> {
    try {
      if (file.size > BACKUP_LIMITS.maximumImportBytes) throw new UserInputError("Файл превышает допустимый размер 50 МБ.");
      const backup = this.backupService.parseBackup(await file.text(), file.size);
      await this.renderImportConfiguration(dialog, backup);
    } catch (error) { this.showDialogError(dialog, error); }
  }

  private async renderImportConfiguration(dialog: HTMLDialogElement, backup: BackupEnvelope): Promise<void> {
    const profiles = await this.service.listPublicProfiles();
    const conflict = profiles.find((profile) => profile.name.trim().toLocaleLowerCase("ru-RU") === backup.profile.name.trim().toLocaleLowerCase("ru-RU"));
    const copyName = conflict ? await this.backupService.suggestCopyName(backup.profile.name) : backup.profile.name;
    dialog.innerHTML = `
      <div class="dialog-heading"><div><p class="eyebrow">Проверка копии</p><h2>Создать импортированный профиль</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
      <p class="dialog-copy">Идей: ${backup.ideas.length}; фотографий: ${backup.images.length}; черновиков: ${backup.drafts.length}. Для входа назначьте новый PIN.</p>
      <form class="stack-form import-form" novalidate>
        <div class="error-summary" role="alert" hidden></div>
        <fieldset class="import-mode" ${conflict ? "" : "hidden"}><legend>Профиль с исходным именем уже существует</legend><label><input type="radio" name="mode" value="copy" checked /> Создать независимую копию</label><label><input type="radio" name="mode" value="replace" /> Заменить существующий профиль</label></fieldset>
        <label class="field"><span>Имя профиля</span><input name="name" maxlength="40" required /></label>
        <div class="field-grid"><label class="field"><span>Новый PIN</span><input name="pin" type="password" inputmode="numeric" maxlength="4" required /></label><label class="field"><span>Повторите новый PIN</span><input name="pinConfirmation" type="password" inputmode="numeric" maxlength="4" required /></label></div>
        <div class="replace-fields" hidden><p class="notice notice--danger">Перед заменой рекомендуется экспортировать существующий профиль. Автоматического объединения нет.</p><label class="field"><span>PIN существующего профиля</span><input name="currentPin" type="password" inputmode="numeric" maxlength="4" /></label><label class="field"><span>Введите УДАЛИТЬ</span><input name="word" /></label></div>
        <progress max="1" value="0" hidden></progress><p class="import-progress" role="status"></p>
        <button class="button button--primary button--wide" type="submit">Импортировать</button>
      </form>
    `;
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    const name = form.elements.namedItem("name") as HTMLInputElement;
    name.value = copyName;
    const updateMode = (): void => {
      const replace = new FormData(form).get("mode") === "replace";
      dialog.querySelector<HTMLElement>(".replace-fields")!.hidden = !replace;
      if (conflict) name.value = replace ? backup.profile.name : copyName;
    };
    form.addEventListener("change", (event) => { if ((event.target as HTMLInputElement).name === "mode") updateMode(); });
    dialog.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener("click", () => this.closeDialog());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const replace = conflict && data.get("mode") === "replace";
      const progress = form.querySelector<HTMLProgressElement>("progress")!;
      const status = form.querySelector<HTMLElement>(".import-progress")!;
      progress.hidden = false;
      try {
        const result = await this.backupService.importBackup(backup, {
          name: String(data.get("name") ?? ""), pin: String(data.get("pin") ?? ""), pinConfirmation: String(data.get("pinConfirmation") ?? ""),
          replace: replace ? { profileId: conflict.id, currentPin: String(data.get("currentPin") ?? ""), confirmationWord: String(data.get("word") ?? "") } : undefined,
        }, (stage, done, total) => { progress.max = Math.max(1, total); progress.value = done; status.textContent = `${stage}: ${done} из ${total}.`; });
        this.closeDialog();
        if (replace && this.service.session?.profileId === conflict.id) {
          this.service.logout();
          await this.renderProfiles(`Профиль заменён из копии: ${result.ideaCount} идей. Войдите с новым PIN.`);
        } else if (this.service.session) {
          this.showToast(`Импортировано идей: ${result.ideaCount}. Предупреждений: ${result.warnings.length}.`);
        } else {
          await this.renderProfiles(`Импортирован профиль «${String(data.get("name") ?? "")}»: ${result.ideaCount} идей.`);
        }
      } catch (error) { this.showFormError(form, error); }
    });
    updateMode();
  }

  private openDiagnosticsDialog(trigger: HTMLElement): void {
    this.openDialog(trigger, `
      <div class="dialog-heading"><div><p class="eyebrow">Локальная диагностика</p><h2>Технический отчёт</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
      <p class="dialog-copy">Отчёт содержит только время, версию приложения, тип браузера, код, операцию и обезличенное сообщение максимум для 50 ошибок. PIN, имена профилей, идеи, фотографии и адреса не включаются.</p>
      <div class="notice" role="status">Подготавливаем сведения…</div><div class="dialog-actions"><button class="button button--primary" type="button" data-download-report>Скачать отчёт</button><button class="button button--secondary danger-text" type="button" data-clear-report>Очистить журнал</button></div>
    `, (dialog) => {
      const notice = dialog.querySelector<HTMLElement>(".notice")!;
      void this.reportService.createReport().then((report) => { notice.textContent = `Записей в журнале: ${report.count}.`; });
      dialog.querySelector<HTMLButtonElement>("[data-download-report]")?.addEventListener("click", async () => {
        const report = await this.reportService.createReport();
        this.downloadText(report.text, report.filename);
        notice.textContent = `Скачано записей: ${report.count}.`;
      });
      dialog.querySelector<HTMLButtonElement>("[data-clear-report]")?.addEventListener("click", async () => {
        if (!window.confirm("Очистить локальный журнал технических ошибок?")) return;
        await this.reportService.clear();
        notice.textContent = "Журнал очищен.";
      });
    });
  }

  private openAboutDialog(trigger: HTMLElement): void {
    this.openDialog(trigger, `
      <div class="dialog-heading"><div><p class="eyebrow">Время идеи</p><h2>О приложении</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
      <div class="about-copy"><p>Все профили, идеи и фотографии хранятся только в этом браузере. Сервера, облачной синхронизации и восстановления забытого PIN нет.</p><p>Очистка данных сайта, удаление браузера или сбой устройства могут необратимо удалить данные. Service Worker и кэш не являются резервной копией. Регулярно скачивайте экспорт.</p><p>Локальный PIN скрывает профиль в интерфейсе, но не является криптографической защитой файлов браузера.</p></div>
      <div class="dialog-actions"><button class="button button--secondary" type="button" data-install-help>Как установить приложение</button></div>
    `, (dialog) => {
      dialog.querySelector<HTMLButtonElement>("[data-install-help]")?.addEventListener("click", (event) => {
        this.closeDialog();
        this.pwa.openInstallInstructions(event.currentTarget as HTMLButtonElement);
      });
    });
  }

  private formatBytes(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
  }

  private openCategoriesDialog(trigger: HTMLElement): void {
    this.openDialog(
      trigger,
      `
        <div class="dialog-heading">
          <div><p class="eyebrow">Организация</p><h2>Категории</h2></div>
          <button class="icon-button" type="button" data-close aria-label="Закрыть">×</button>
        </div>
        <p class="dialog-copy">У каждой идеи одна категория. Начальные категории можно переименовать, но нельзя удалить.</p>
        <form class="category-create" novalidate>
          <label class="field"><span>Новая категория</span><input name="categoryName" maxlength="30" required /></label>
          <button class="button button--secondary" type="submit">Добавить</button>
        </form>
        <div class="error-summary" role="alert" hidden></div>
        <div class="category-list"></div>
      `,
      (dialog) => {
        const refresh = async (): Promise<void> => {
          const list = dialog.querySelector<HTMLElement>(".category-list");
          if (!list) return;
          list.replaceChildren();
          for (const category of await this.service.listCategories()) {
            list.append(this.makeCategoryRow(category, refresh, dialog));
          }
        };
        const form = dialog.querySelector<HTMLFormElement>(".category-create");
        form?.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            await this.service.createCategory(String(new FormData(form).get("categoryName") ?? ""));
            form.reset();
            this.clearDialogError(dialog);
            await refresh();
          } catch (error) {
            this.showDialogError(dialog, error);
          }
        });
        void refresh();
      },
      { wide: true },
    );
  }

  private makeCategoryRow(
    category: Category,
    refresh: () => Promise<void>,
    dialog: HTMLDialogElement,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "category-row";
    const information = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = category.name;
    information.append(name);
    if (category.isSystem) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Начальная";
      information.append(badge);
    }
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "text-button";
    rename.textContent = "Переименовать";
    rename.addEventListener("click", () => {
      const form = document.createElement("form");
      form.className = "inline-edit";
      const input = document.createElement("input");
      input.name = "name";
      input.value = category.name;
      input.maxLength = 30;
      input.setAttribute("aria-label", `Новое название категории ${category.name}`);
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "button button--small";
      save.textContent = "Сохранить";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "text-button";
      cancel.textContent = "Отмена";
      cancel.addEventListener("click", () => void refresh());
      form.append(input, save, cancel);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          await this.service.renameCategory(category.id, input.value);
          this.clearDialogError(dialog);
          await refresh();
        } catch (error) {
          this.showDialogError(dialog, error);
        }
      });
      row.replaceChildren(form);
      input.focus();
      input.select();
    });
    actions.append(rename);
    if (!category.isSystem) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button danger-text";
      remove.textContent = "Удалить";
      remove.addEventListener("click", async () => {
        try {
          await this.service.deleteCategory(category.id);
          this.clearDialogError(dialog);
          await refresh();
        } catch (error) {
          this.showDialogError(dialog, error);
        }
      });
      actions.append(remove);
    }
    row.append(information, actions);
    return row;
  }

  private openRenameProfileDialog(trigger: HTMLElement): void {
    this.openDialog(
      trigger,
      `
        <div class="dialog-heading"><div><p class="eyebrow">Профиль</p><h2>Изменить имя</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
        <form class="stack-form" novalidate>
          <div class="error-summary" role="alert" hidden></div>
          <label class="field"><span>Новое имя</span><input name="name" maxlength="40" required /></label>
          <label class="field"><span>Текущий PIN</span><input name="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required /></label>
          <button class="button button--primary button--wide" type="submit">Сохранить имя</button>
        </form>
      `,
      (dialog) => this.bindSimpleForm(dialog, async (form) => {
        const data = new FormData(form);
        await this.service.renameProfile(String(data.get("name") ?? ""), String(data.get("pin") ?? ""));
        this.closeDialog();
        await this.renderToday();
        this.root.querySelector<HTMLButtonElement>(".menu-button")?.focus();
        this.showToast("Имя профиля изменено.");
      }),
    );
  }

  private openChangePinDialog(trigger: HTMLElement): void {
    this.openDialog(
      trigger,
      `
        <div class="dialog-heading"><div><p class="eyebrow">Профиль</p><h2>Изменить PIN</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
        <form class="stack-form" novalidate>
          <div class="error-summary" role="alert" hidden></div>
          <label class="field"><span>Текущий PIN</span><input name="currentPin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required /></label>
          <label class="field"><span>Новый PIN</span><input name="newPin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password" required /></label>
          <label class="field"><span>Повторите новый PIN</span><input name="confirmation" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password" required /></label>
          <button class="button button--primary button--wide" type="submit">Изменить PIN</button>
        </form>
      `,
      (dialog) => this.bindSimpleForm(dialog, async (form) => {
        const data = new FormData(form);
        await this.service.changePin(
          String(data.get("currentPin") ?? ""),
          String(data.get("newPin") ?? ""),
          String(data.get("confirmation") ?? ""),
        );
        this.closeDialog();
        this.showToast("PIN-код изменён.");
      }),
    );
  }

  private openDangerDialog(trigger: HTMLElement, action: "clear" | "delete"): void {
    const isDelete = action === "delete";
    this.openDialog(
      trigger,
      `
        <div class="dialog-heading"><div><p class="eyebrow danger-text">Необратимое действие</p><h2>${isDelete ? "Удалить профиль" : "Очистить профиль"}</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
        <p class="dialog-copy">${isDelete ? "Профиль, идеи, архив, категории, черновики и настройки будут удалены." : "Все идеи, архив и черновики будут удалены. Профиль останется, а категории сбросятся до «Личное» и «Работа»."}</p>
        <form class="stack-form" novalidate>
          <div class="error-summary" role="alert" hidden></div>
          <label class="field"><span>Текущий PIN</span><input name="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required /></label>
          <label class="field"><span>Введите УДАЛИТЬ</span><input name="word" autocomplete="off" required /></label>
          <button class="button button--danger button--wide" type="submit">${isDelete ? "Продолжить" : "Очистить данные"}</button>
        </form>
      `,
      (dialog) => this.bindSimpleForm(dialog, async (form) => {
        const data = new FormData(form);
        const pin = String(data.get("pin") ?? "");
        const word = String(data.get("word") ?? "");
        if (!isDelete) {
          await this.service.clearCurrentProfile(pin, word);
          this.closeDialog();
          this.showToast("Данные профиля очищены.");
          return;
        }
        await this.service.confirmCurrentPin(pin);
        if (word !== "УДАЛИТЬ") throw new UserInputError("Введите слово УДАЛИТЬ русскими заглавными буквами.");
        this.renderFinalDeleteConfirmation(dialog, pin, word);
      }),
      { dangerous: true },
    );
  }

  private renderFinalDeleteConfirmation(dialog: HTMLDialogElement, pin: string, word: string): void {
    dialog.dataset.locked = "true";
    dialog.innerHTML = `
      <div class="final-confirmation">
        <div class="danger-symbol" aria-hidden="true">!</div>
        <h2>Удалить профиль окончательно?</h2>
        <p>Отменить это действие и восстановить локальные данные будет невозможно.</p>
        <div class="final-actions">
          <button class="button button--secondary" type="button" data-cancel-final>Вернуться</button>
          <button class="button button--danger" type="button" data-confirm-final>Да, удалить профиль</button>
        </div>
        <div class="error-summary" role="alert" hidden></div>
      </div>
    `;
    dialog.querySelector<HTMLButtonElement>("[data-cancel-final]")?.addEventListener("click", () => {
      delete dialog.dataset.locked;
      this.closeDialog();
    });
    dialog.querySelector<HTMLButtonElement>("[data-confirm-final]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        await this.service.deleteCurrentProfile(pin, word);
        delete dialog.dataset.locked;
        this.closeDialog();
        await this.renderProfiles("Профиль удалён.");
      } catch (error) {
        button.disabled = false;
        this.showDialogError(dialog, error);
      }
    });
  }

  private bindSimpleForm(
    dialog: HTMLDialogElement,
    handler: (form: HTMLFormElement) => Promise<void>,
  ): void {
    const form = dialog.querySelector<HTMLFormElement>("form");
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      this.setFormBusy(form, true);
      try {
        await handler(form);
      } catch (error) {
        this.showFormError(form, error);
      } finally {
        this.setFormBusy(form, false);
      }
    });
  }

  private openDialog(
    trigger: HTMLElement,
    contents: string,
    setup: DialogSetup,
    options: { wide?: boolean; dangerous?: boolean } = {},
  ): void {
    this.closeDialog();
    const dialog = document.createElement("dialog");
    dialog.className = `modal${options.wide ? " modal--wide" : ""}${options.dangerous ? " modal--danger" : ""}`;
    dialog.innerHTML = contents;
    dialog.addEventListener("cancel", (event) => {
      if (dialog.dataset.locked === "true") event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (this.activeDialog === dialog) this.activeDialog = null;
      if (document.contains(trigger)) trigger.focus();
    }, { once: true });
    dialog.querySelectorAll<HTMLElement>("[data-close]").forEach((button) =>
      button.addEventListener("click", () => this.closeDialog()),
    );
    document.body.append(dialog);
    this.activeDialog = dialog;
    setup(dialog);
    dialog.showModal();
    (dialog.querySelector<HTMLElement>("[autofocus]") ??
      dialog.querySelector<HTMLElement>("input") ??
      dialog.querySelector<HTMLElement>("button"))?.focus();
  }

  private closeDialog(): void {
    if (this.activeDialog?.open) this.activeDialog.close();
  }

  private setFormBusy(form: HTMLFormElement, busy: boolean): void {
    form.setAttribute("aria-busy", String(busy));
    form.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
      control.disabled = busy;
    });
  }

  private showFormError(form: HTMLFormElement, error: unknown): void {
    const summary = form.querySelector<HTMLElement>(".error-summary");
    if (!summary) return;
    summary.hidden = false;
    summary.textContent = this.errorMessage(error);
    if (error instanceof UserInputError && error.field) {
      const field = form.querySelector<HTMLElement>(`[name='${error.field}']`);
      if (field) {
        field.setAttribute("aria-invalid", "true");
        const id = `${error.field}-error-${crypto.randomUUID()}`;
        const fieldError = document.createElement("span");
        fieldError.id = id;
        fieldError.className = "field-error";
        fieldError.textContent = error.message;
        field.setAttribute("aria-describedby", [field.getAttribute("aria-describedby"), id].filter(Boolean).join(" "));
        field.closest(".field")?.append(fieldError);
        field.focus();
      }
    }
  }

  private bindInstallHelp(): void {
    this.root.querySelectorAll<HTMLButtonElement>("[data-install-help]").forEach((button) => {
      button.addEventListener("click", () => this.pwa.openInstallInstructions(button));
    });
  }

  private showDialogError(dialog: HTMLDialogElement, error: unknown): void {
    const summary = dialog.querySelector<HTMLElement>(".error-summary");
    if (!summary) return;
    summary.hidden = false;
    summary.textContent = this.errorMessage(error);
  }

  private clearDialogError(dialog: HTMLDialogElement): void {
    const summary = dialog.querySelector<HTMLElement>(".error-summary");
    if (summary) {
      summary.hidden = true;
      summary.textContent = "";
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return "Не удалось выполнить действие. Попробуйте снова.";
  }

  private showToast(message: string): void {
    const region = this.root.querySelector<HTMLElement>(".toast-region");
    if (!region) return;
    region.textContent = message;
    region.classList.add("is-visible");
    window.setTimeout(() => region.classList.remove("is-visible"), 3_000);
  }
}

export function renderStorageFailure(root: HTMLDivElement, error: unknown): void {
  root.innerHTML = `
    <main class="welcome-screen">
      <section class="welcome-card" aria-labelledby="storage-error-title">
        <p class="eyebrow danger-text">Хранилище недоступно</p>
        <h1 id="storage-error-title">Не удалось открыть данные</h1>
        <div class="notice notice--danger" role="alert"></div>
        <p class="dialog-copy">Не очищайте данные сайта. Проверьте настройки браузера и перезагрузите страницу.</p>
        <button class="button button--primary" type="button" data-reload>Перезагрузить</button>
      </section>
    </main>
  `;
  const notice = root.querySelector<HTMLElement>(".notice");
  if (notice) notice.textContent = explainStorageError(error);
  root.querySelector<HTMLButtonElement>("[data-reload]")?.addEventListener("click", () => location.reload());
}
