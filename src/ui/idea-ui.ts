import { addCalendarDays, formatCalendarDate, toLocalCalendarDate } from "../domain/dates";
import type { Category, DraftImage, Idea, NestedSubtask, Subtask } from "../domain/types";
import {
  ALLOWED_STATUS_TRANSITIONS,
  IdeaService,
  createEmptyIdeaInput,
  subtaskProgress,
  type IdeaInput,
  type LinkedSource,
} from "../application/idea-service";
import { STATUS_LABELS, isArchived, isOverdue } from "../application/idea-list-service";
import { UserInputError } from "../application/profile-service";
import { processImage } from "../application/image-processor";
import { renderSafeText } from "./safe-text";

function cloneSubtasks(value: Subtask[]): Subtask[] {
  return structuredClone(value);
}

function leafSubtaskCount(value: Subtask[]): number {
  return value.reduce((total, item) => total + Math.max(1, item.children.length), 0);
}

function imageEquals(left: DraftImage | null, right: DraftImage | null): boolean {
  if (!left || !right) return left === right;
  return left.savedAt === right.savedAt && left.blob.size === right.blob.size;
}

function draftData(input: IdeaInput): Partial<Idea> {
  return {
    title: input.title,
    description: input.description,
    notes: input.notes,
    categoryId: input.categoryId,
    priority: input.priority,
    complexity: input.complexity,
    returnMode: input.returnMode,
    returnDate: input.returnDate,
    returnWeeks: input.returnWeeks,
    complexDetails: input.complexDetails,
    subtasks: input.subtasks,
  };
}

function mergeDraft(input: IdeaInput, data: Partial<Idea>): IdeaInput {
  return {
    ...input,
    title: data.title ?? input.title,
    description: data.description ?? input.description,
    notes: data.notes ?? input.notes,
    categoryId: data.categoryId ?? input.categoryId,
    priority: data.priority ?? input.priority,
    complexity: data.complexity ?? input.complexity,
    returnMode: data.returnMode === undefined ? input.returnMode : data.returnMode,
    returnDate: data.returnDate === undefined ? input.returnDate : data.returnDate,
    returnWeeks: data.returnWeeks === undefined ? input.returnWeeks : data.returnWeeks,
    complexDetails: data.complexDetails ?? input.complexDetails,
    subtasks: data.subtasks ? cloneSubtasks(data.subtasks) : input.subtasks,
  };
}

function ideaToInput(idea: Idea): IdeaInput {
  return {
    title: idea.title,
    description: idea.description,
    notes: idea.notes,
    categoryId: idea.categoryId,
    priority: idea.priority,
    complexity: idea.complexity,
    returnMode: idea.returnMode,
    returnDate: idea.returnDate,
    returnWeeks: idea.returnWeeks,
    complexDetails: structuredClone(idea.complexDetails),
    subtasks: cloneSubtasks(idea.subtasks),
    image: undefined,
  };
}

function createNestedSubtask(title = ""): NestedSubtask {
  return {
    id: crypto.randomUUID(),
    title,
    description: "",
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    linkedIdeaId: null,
  };
}

function createSubtask(): Subtask {
  return { ...createNestedSubtask(), children: [] };
}

export class IdeaUi {
  private dialog: HTMLDialogElement | null = null;

  constructor(
    private readonly service: IdeaService,
    private readonly categories: () => Promise<Category[]>,
    private readonly onChanged: () => Promise<void>,
  ) {}

  async openCreate(trigger: HTMLElement, prefill?: IdeaInput, source?: LinkedSource): Promise<void> {
    const categories = await this.categories();
    if (!categories.length) throw new UserInputError("Сначала создайте категорию.");
    const input = prefill ?? createEmptyIdeaInput(categories[0]!.id);
    await this.openForm(trigger, input, categories, undefined, null, source);
  }

  async openEdit(trigger: HTMLElement, ideaId: string): Promise<void> {
    const [{ idea, image }, categories] = await Promise.all([
      this.service.getIdea(ideaId),
      this.categories(),
    ]);
    await this.openForm(trigger, ideaToInput(idea), categories, idea, image);
  }

  async openPostpone(trigger: HTMLElement, ideaId: string): Promise<void> {
    const { idea } = await this.service.getIdea(ideaId);
    const dialog = this.makeDialog(trigger, "postpone-modal");
    const today = toLocalCalendarDate();
    dialog.innerHTML = `
      <div class="dialog-heading"><div><p class="eyebrow">Новая дата</p><h2>Отложить идею</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">×</button></div>
      <p class="dialog-copy"></p>
      <form class="stack-form" novalidate>
        <div class="error-summary" role="alert" hidden></div>
        <label class="field"><span>Дата возвращения</span><input name="postponeDate" type="date" min="${today}" value="${idea.returnDate && idea.returnDate >= today ? idea.returnDate : ""}" /></label>
        <div class="postpone-actions"><button class="button button--secondary" type="button" data-without-date>Оставить без даты</button><button class="button button--primary" type="submit">Отложить</button></div>
      </form>
    `;
    const copy = dialog.querySelector<HTMLElement>(".dialog-copy");
    if (copy) copy.textContent = `Для идеи «${idea.title}» можно назначить новую дату или оставить её без даты.`;
    const perform = async (date: string | null): Promise<void> => {
      try {
        await this.service.postponeIdea(idea.id, date);
        dialog.close();
        await this.onChanged();
      } catch (error) {
        this.showFormError(dialog.querySelector<HTMLFormElement>("form")!, error);
      }
    };
    dialog.querySelector<HTMLFormElement>("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget as HTMLFormElement).get("postponeDate") ?? "");
      void perform(value || null);
    });
    dialog.querySelector<HTMLButtonElement>("[data-without-date]")?.addEventListener("click", () => void perform(null));
    this.bindClose(dialog);
    dialog.showModal();
  }

  async openDetails(trigger: HTMLElement, ideaId: string): Promise<void> {
    const [{ idea, image }, categories] = await Promise.all([
      this.service.getIdea(ideaId),
      this.categories(),
    ]);
    const category = categories.find((item) => item.id === idea.categoryId);
    const dialog = this.makeDialog(trigger, "idea-details-modal");
    dialog.innerHTML = `
      <div class="dialog-heading">
        <div><p class="eyebrow">Подробности идеи</p><h2 data-title></h2></div>
        <button class="icon-button" type="button" data-close aria-label="Закрыть">×</button>
      </div>
      <div class="idea-meta" data-meta></div>
      <p class="idea-description" data-description></p>
      <div class="source-note" data-source hidden></div>
      <section class="detail-section"><h3>Заметки</h3><p data-notes></p></section>
      <section class="detail-section" data-complex-section hidden><h3>Детали сложной идеи</h3><dl class="details-grid"></dl></section>
      <section class="detail-section"><div class="section-heading"><h3>Подзадачи</h3><span data-progress></span></div><div class="detail-subtasks"></div></section>
      <details class="detail-section status-history"><summary>История статусов <span data-history-count></span></summary><ol data-history></ol></details>
      <section class="detail-section" data-photo-section hidden><h3>Фотография</h3><button class="photo-view-button" type="button"><img data-photo alt="" /></button></section>
      <div class="detail-actions"></div>
    `;
    const title = dialog.querySelector<HTMLElement>("[data-title]");
    const description = dialog.querySelector<HTMLElement>("[data-description]");
    const notes = dialog.querySelector<HTMLElement>("[data-notes]");
    if (title) title.textContent = idea.title;
    if (description) renderSafeText(description, idea.description);
    if (notes) renderSafeText(notes, idea.notes || "Заметок нет");
    const meta = dialog.querySelector<HTMLElement>("[data-meta]");
    for (const value of [
      category?.name ?? "Категория удалена",
      idea.priority === "high" ? "Высокий приоритет" : idea.priority === "low" ? "Низкий приоритет" : "Средний приоритет",
      idea.complexity === "complex" ? "Сложная" : "Простая",
      STATUS_LABELS[idea.status],
      idea.returnDate ? `Вернуться ${formatCalendarDate(idea.returnDate)}` : "Дата не назначена",
      isOverdue(idea, toLocalCalendarDate()) ? "Просрочено" : "",
    ]) {
      if (!value) continue;
      const tag = document.createElement("span");
      tag.textContent = value;
      meta?.append(tag);
    }
    const source = dialog.querySelector<HTMLElement>("[data-source]");
    if (source && (idea.sourceIdeaId || idea.sourceWasDeleted)) {
      source.hidden = false;
      source.textContent = idea.sourceWasDeleted ? "Исходная идея удалена" : "Создана из подзадачи другой идеи";
    }
    if (idea.complexity === "complex" || idea.subtasks.length || Object.values(idea.complexDetails).some(Boolean)) {
      const section = dialog.querySelector<HTMLElement>("[data-complex-section]");
      if (section) section.hidden = false;
      const details = dialog.querySelector<HTMLElement>(".details-grid");
      const rows: Array<[string, string]> = [
        ["Несколько этапов", idea.complexDetails.isMultiStage === null ? "Не указано" : idea.complexDetails.isMultiStage ? "Да" : "Нет"],
        ["Ожидаемый результат", idea.complexDetails.expectedResult || "Не указано"],
        ["Ресурсы", idea.complexDetails.requiredResources || "Не указано"],
        ["Препятствия", idea.complexDetails.blockers || "Не указано"],
        ["Первый шаг", idea.complexDetails.firstStep || "Не указано"],
        ["Комментарий о сроке", idea.complexDetails.deadlineComment || "Не указано"],
      ];
      for (const [term, value] of rows) {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = term;
        dd.textContent = value;
        details?.append(dt, dd);
      }
    }
    const progress = subtaskProgress(idea);
    const progressElement = dialog.querySelector<HTMLElement>("[data-progress]");
    if (progressElement) progressElement.textContent = `${progress.completed} из ${progress.total}`;
    this.renderDetailSubtasks(dialog.querySelector<HTMLElement>(".detail-subtasks"), idea, trigger);
    const history = dialog.querySelector<HTMLOListElement>("[data-history]");
    const historyCount = dialog.querySelector<HTMLElement>("[data-history-count]");
    if (historyCount) historyCount.textContent = `(${idea.statusHistory.length})`;
    if (!idea.statusHistory.length) {
      const empty = document.createElement("li");
      empty.textContent = "Переходов пока нет";
      history?.append(empty);
    } else {
      for (const entry of [...idea.statusHistory].reverse()) {
        const item = document.createElement("li");
        const reason = entry.reason === "date" ? "по наступлению даты" : entry.reason === "restore" ? "восстановление" : "вручную";
        item.textContent = `${STATUS_LABELS[entry.from]} → ${STATUS_LABELS[entry.to]} · ${new Date(entry.changedAt).toLocaleString("ru-RU")} · ${reason}`;
        history?.append(item);
      }
    }
    if (image) {
      const section = dialog.querySelector<HTMLElement>("[data-photo-section]");
      const photo = dialog.querySelector<HTMLImageElement>("[data-photo]");
      const url = URL.createObjectURL(image.blob);
      if (section) section.hidden = false;
      if (photo) {
        photo.src = url;
        photo.alt = `Фотография к идее «${idea.title}»`;
      }
      dialog.addEventListener("close", () => URL.revokeObjectURL(url), { once: true });
      dialog.querySelector<HTMLButtonElement>(".photo-view-button")?.addEventListener("click", () =>
        this.showLightbox(dialog, url, photo?.alt ?? "Фотография идеи"),
      );
    }
    const actions = dialog.querySelector<HTMLElement>(".detail-actions")!;
    const addAction = (label: string, className: string, handler: () => Promise<void> | void): void => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      button.addEventListener("click", () => void handler());
      actions.append(button);
    };
    const runTransition = async (target: "inProgress" | "completed" | "rejected"): Promise<void> => {
      if ((target === "completed" || target === "rejected") &&
        !window.confirm(target === "completed" ? "Отметить идею выполненной?" : "Отказаться от идеи и переместить её в архив?")) return;
      await this.service.transitionIdea(idea.id, target);
      dialog.close();
      await this.onChanged();
    };
    if (isArchived(idea)) {
      addAction("Восстановить", "button button--primary", async () => {
        await this.service.restoreIdea(idea.id);
        dialog.close();
        await this.onChanged();
      });
      addAction("Удалить навсегда", "button button--danger", async () => {
        if (!window.confirm(`Удалить идею «${idea.title}» навсегда? Корзины и отмены нет.`)) return;
        await this.service.deleteIdea(idea.id);
        dialog.close();
        await this.onChanged();
      });
    } else {
      if (ALLOWED_STATUS_TRANSITIONS[idea.status].includes("inProgress")) addAction("Начать", "button button--secondary", () => runTransition("inProgress"));
      if (ALLOWED_STATUS_TRANSITIONS[idea.status].includes("postponed")) addAction("Отложить", "button button--secondary", () => {
        dialog.close();
        void this.openPostpone(trigger, idea.id);
      });
      if (idea.complexity === "simple" && idea.returnDate && idea.returnDate <= toLocalCalendarDate() &&
        ALLOWED_STATUS_TRANSITIONS[idea.status].includes("postponed")) {
        addAction("Напомнить ещё через 4 недели", "button button--secondary", async () => {
          await this.service.repeatInFourWeeks(idea.id);
          dialog.close();
          await this.onChanged();
        });
      }
      if (ALLOWED_STATUS_TRANSITIONS[idea.status].includes("completed")) addAction("Выполнить", "button button--primary", () => runTransition("completed"));
      if (ALLOWED_STATUS_TRANSITIONS[idea.status].includes("rejected")) addAction("Отказаться", "button button--secondary danger-text", () => runTransition("rejected"));
      addAction("Редактировать", "button button--secondary", () => {
        dialog.close();
        void this.openEdit(trigger, idea.id);
      });
      addAction("Удалить", "button button--secondary danger-text", async () => {
        if (!window.confirm(`Удалить идею «${idea.title}»? Действие нельзя отменить.`)) return;
        await this.service.deleteIdea(idea.id);
        dialog.close();
        await this.onChanged();
      });
    }
    this.bindClose(dialog);
    dialog.showModal();
  }

  private async openForm(
    trigger: HTMLElement,
    initial: IdeaInput,
    categories: Category[],
    existing?: Idea,
    existingImage: DraftImage | null = null,
    source?: LinkedSource,
  ): Promise<void> {
    const formId: "draft_new" | `draft_edit_${string}` = existing ? `draft_edit_${existing.id}` : "draft_new";
    const draft = await this.service.getDraft(formId);
    let input = structuredClone({ ...initial, image: undefined }) as IdeaInput;
    let workingImage = existingImage;
    if (draft) {
      const shouldContinue = window.confirm("Найден автоматически сохранённый черновик. Продолжить его? Нажмите «Отмена», чтобы удалить черновик.");
      if (shouldContinue) {
        input = mergeDraft(input, draft.data);
        workingImage = draft.image;
      } else {
        await this.service.deleteDraft(formId);
      }
    }
    let subtasks = cloneSubtasks(input.subtasks);
    let previewUrl: string | null = null;
    let draftTimer: number | null = null;
    let draftPending = false;
    const dialog = this.makeDialog(trigger, "idea-form-modal");
    dialog.innerHTML = `
      <div class="idea-form-header">
        <div><p class="eyebrow">${existing ? "Редактирование" : source ? "Идея из подзадачи" : "Новая идея"}</p><h2>${existing ? "Изменить идею" : "Сохранить идею"}</h2></div>
        <button class="icon-button" type="button" data-close aria-label="Закрыть">×</button>
      </div>
      <form class="idea-form" novalidate>
        <div class="error-summary" role="alert" hidden></div>
        <div class="draft-status" role="status" aria-live="polite">Изменения сохраняются автоматически</div>
        <section class="form-section"><h3>Главное</h3>
          <label class="field"><span>Название *</span><input name="title" maxlength="120" required /></label>
          <label class="field"><span>Краткое описание *</span><textarea name="description" maxlength="1000" rows="4" required></textarea></label>
          <div class="form-grid-3">
            <label class="field"><span>Категория *</span><select name="categoryId" required></select></label>
            <label class="field"><span>Приоритет</span><select name="priority"><option value="low">Низкий</option><option value="medium">Средний</option><option value="high">Высокий</option></select></label>
            <label class="field"><span>Сложность *</span><select name="complexity"><option value="simple">Простая</option><option value="complex">Сложная</option></select></label>
          </div>
          <p class="complexity-note">При переключении на простую идею ответы и подзадачи сохранятся и будут доступны при возврате к сложной.</p>
        </section>
        <section class="form-section"><h3>Когда вернуться</h3>
          <label class="field"><span>Способ</span><select name="returnMode"><option value="">Без даты</option><option value="date">Конкретная дата</option><option value="weeks">Через несколько недель</option></select></label>
          <label class="field" data-date-field hidden><span>Дата возвращения</span><input name="returnDate" type="date" /></label>
          <label class="field" data-weeks-field hidden><span>Количество недель</span><input name="returnWeeks" type="number" min="1" max="520" step="1" /><output class="calculated-date"></output></label>
        </section>
        <section class="form-section complex-fields" hidden><h3>Детали сложной идеи</h3>
          <div class="form-grid-2"><label class="field"><span>Это несколько этапов?</span><select name="isMultiStage"><option value="">Не указано</option><option value="true">Да</option><option value="false">Нет</option></select></label><label class="field"><span>Есть описательный срок?</span><select name="hasDeadline"><option value="">Не указано</option><option value="true">Да</option><option value="false">Нет</option></select></label></div>
          <label class="field"><span>Ожидаемый результат</span><textarea name="expectedResult" maxlength="2000" rows="3"></textarea></label>
          <label class="field"><span>Необходимые ресурсы</span><textarea name="requiredResources" maxlength="2000" rows="3"></textarea></label>
          <label class="field"><span>Возможные препятствия</span><textarea name="blockers" maxlength="2000" rows="3"></textarea></label>
          <label class="field"><span>Первый шаг</span><textarea name="firstStep" maxlength="2000" rows="3"></textarea></label>
          <label class="field"><span>Комментарий о сроке</span><input name="deadlineComment" maxlength="500" /></label>
        </section>
        <details class="saved-complex" hidden><summary>Сохранённые данные сложной идеи</summary><p>Ответы и подзадачи скрыты, но не удалены.</p></details>
        <section class="form-section"><div class="section-heading"><h3>Подзадачи</h3><button class="button button--secondary button--small" type="button" data-add-subtask>Добавить подзадачу</button></div><div class="subtask-editor"></div></section>
        <section class="form-section"><h3>Заметки и фотография</h3>
          <label class="field"><span>Заметки</span><textarea name="notes" maxlength="5000" rows="5"></textarea></label>
          <label class="field"><span>Фотография JPEG, PNG или WebP</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" /></label>
          <div class="image-processing" role="status" aria-live="polite" hidden>Обрабатываем фотографию…</div>
          <div class="image-preview" hidden><button type="button" data-preview-image><img alt="Предпросмотр фотографии" /></button><div><button class="text-button" type="button" data-replace-image>Заменить</button><button class="text-button danger-text" type="button" data-remove-image>Удалить</button></div></div>
        </section>
        <div class="sticky-actions"><button class="button button--secondary" type="button" data-cancel>Закрыть</button><button class="button button--primary" type="submit" disabled>Сохранить идею</button></div>
      </form>
    `;
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    const select = form.elements.namedItem("categoryId") as HTMLSelectElement;
    for (const category of categories) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      select.append(option);
    }
    this.fillForm(form, input);
    const subtaskEditor = dialog.querySelector<HTMLElement>(".subtask-editor")!;
    const reportSubtaskLimit = (message: string): void => this.showFormError(form, new UserInputError(message, "subtasks"));
    const renderSubtasks = (): void => this.renderSubtaskEditor(subtaskEditor, subtasks, scheduleDraft, reportSubtaskLimit);
    const refreshConditional = (): void => {
      const complexity = (form.elements.namedItem("complexity") as HTMLSelectElement).value;
      const complex = dialog.querySelector<HTMLElement>(".complex-fields");
      const saved = dialog.querySelector<HTMLDetailsElement>(".saved-complex");
      if (complex) complex.hidden = complexity !== "complex";
      if (saved) saved.hidden = complexity === "complex" || (!subtasks.length && !Object.values(input.complexDetails).some(Boolean));
      const mode = (form.elements.namedItem("returnMode") as HTMLSelectElement).value;
      dialog.querySelector<HTMLElement>("[data-date-field]")!.hidden = mode !== "date";
      dialog.querySelector<HTMLElement>("[data-weeks-field]")!.hidden = mode !== "weeks";
      const weeks = Number((form.elements.namedItem("returnWeeks") as HTMLInputElement).value);
      const output = dialog.querySelector<HTMLOutputElement>(".calculated-date");
      if (output) output.textContent = mode === "weeks" && Number.isInteger(weeks) && weeks >= 1 && weeks <= 520
        ? `Дата: ${formatCalendarDate(addCalendarDays(toLocalCalendarDate(), weeks * 7))}` : "";
      this.updateSaveAvailability(form);
    };
    const readInput = (): IdeaInput => this.readForm(form, subtasks, workingImage);
    const flushDraft = async (): Promise<void> => {
      if (draftTimer !== null) window.clearTimeout(draftTimer);
      draftTimer = null;
      if (!draftPending) return;
      const status = dialog.querySelector<HTMLElement>(".draft-status");
      try {
        const current = readInput();
        await this.service.saveDraft(formId, draftData(current), workingImage);
        draftPending = false;
        if (status) status.textContent = "Черновик сохранён";
      } catch (error) {
        if (status) status.textContent = "Не удалось сохранить черновик";
      }
    };
    function scheduleDraft(): void {
      draftPending = true;
      if (draftTimer !== null) window.clearTimeout(draftTimer);
      const status = dialog.querySelector<HTMLElement>(".draft-status");
      if (status) status.textContent = "Сохраняем черновик…";
      draftTimer = window.setTimeout(() => void flushDraft(), 700);
    }
    form.addEventListener("input", () => { refreshConditional(); scheduleDraft(); });
    form.addEventListener("change", () => { refreshConditional(); scheduleDraft(); });
    dialog.querySelector<HTMLButtonElement>("[data-add-subtask]")?.addEventListener("click", () => {
      if (subtasks.length >= 100) {
        reportSubtaskLimit("Можно добавить не более 100 подзадач первого уровня.");
        return;
      }
      if (leafSubtaskCount(subtasks) >= 500) {
        reportSubtaskLimit("Можно добавить не более 500 конечных подзадач.");
        return;
      }
      subtasks.push(createSubtask());
      renderSubtasks();
      scheduleDraft();
    });
    const imageInput = form.elements.namedItem("image") as HTMLInputElement;
    imageInput.addEventListener("change", async () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      const processing = dialog.querySelector<HTMLElement>(".image-processing");
      if (processing) processing.hidden = false;
      try {
        workingImage = await processImage(file);
        this.clearError(form);
        updatePreview();
        scheduleDraft();
      } catch (error) {
        this.showFormError(form, error);
      } finally {
        if (processing) processing.hidden = true;
        imageInput.value = "";
      }
    });
    const updatePreview = (): void => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = workingImage ? URL.createObjectURL(workingImage.blob) : null;
      const preview = dialog.querySelector<HTMLElement>(".image-preview");
      const image = preview?.querySelector<HTMLImageElement>("img");
      if (preview) preview.hidden = !previewUrl;
      if (image && previewUrl) image.src = previewUrl;
    };
    dialog.querySelector<HTMLButtonElement>("[data-remove-image]")?.addEventListener("click", () => {
      workingImage = null;
      updatePreview();
      scheduleDraft();
    });
    dialog.querySelector<HTMLButtonElement>("[data-replace-image]")?.addEventListener("click", () => imageInput.click());
    dialog.querySelector<HTMLButtonElement>("[data-preview-image]")?.addEventListener("click", () => {
      if (previewUrl) this.showLightbox(dialog, previewUrl, "Предпросмотр фотографии идеи");
    });
    const closeForm = async (): Promise<void> => {
      await flushDraft();
      dialog.close();
    };
    dialog.querySelectorAll<HTMLButtonElement>("[data-close], [data-cancel]").forEach((button) =>
      button.addEventListener("click", () => void closeForm()),
    );
    dialog.addEventListener("cancel", (event) => {
      if (draftPending) {
        event.preventDefault();
        void closeForm();
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>("button[type='submit']")!;
      submit.disabled = true;
      try {
        const current = readInput();
        if (existing) {
          current.image = imageEquals(workingImage, existingImage) ? undefined : workingImage;
          await this.service.updateIdea(existing.id, current);
        } else {
          current.image = workingImage;
          await this.service.createIdea(current, source);
        }
        draftPending = false;
        dialog.close();
        await this.onChanged();
      } catch (error) {
        this.showFormError(form, error);
        this.updateSaveAvailability(form);
      }
    });
    dialog.addEventListener("close", () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (draftTimer !== null) window.clearTimeout(draftTimer);
    }, { once: true });
    renderSubtasks();
    refreshConditional();
    updatePreview();
    dialog.showModal();
    (form.elements.namedItem("title") as HTMLInputElement).focus();
  }

  private fillForm(form: HTMLFormElement, input: IdeaInput): void {
    const set = (name: string, value: string): void => {
      const field = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (field) field.value = value;
    };
    set("title", input.title);
    set("description", input.description);
    set("notes", input.notes);
    set("categoryId", input.categoryId);
    set("priority", input.priority);
    set("complexity", input.complexity);
    set("returnMode", input.returnMode ?? "");
    set("returnDate", input.returnDate ?? "");
    set("returnWeeks", input.returnWeeks ? String(input.returnWeeks) : "");
    const details = input.complexDetails;
    set("isMultiStage", details.isMultiStage === null ? "" : String(details.isMultiStage));
    set("hasDeadline", details.hasDeadline === null ? "" : String(details.hasDeadline));
    set("expectedResult", details.expectedResult);
    set("requiredResources", details.requiredResources);
    set("blockers", details.blockers);
    set("firstStep", details.firstStep);
    set("deadlineComment", details.deadlineComment);
  }

  private readForm(form: HTMLFormElement, subtasks: Subtask[], image: DraftImage | null): IdeaInput {
    const data = new FormData(form);
    const triState = (name: string): boolean | null => {
      const value = String(data.get(name) ?? "");
      return value === "" ? null : value === "true";
    };
    const modeValue = String(data.get("returnMode") ?? "");
    const returnMode = modeValue === "date" || modeValue === "weeks" ? modeValue : null;
    const weeksText = String(data.get("returnWeeks") ?? "");
    return {
      title: String(data.get("title") ?? ""),
      description: String(data.get("description") ?? ""),
      notes: String(data.get("notes") ?? ""),
      categoryId: String(data.get("categoryId") ?? ""),
      priority: String(data.get("priority") ?? "medium") as IdeaInput["priority"],
      complexity: String(data.get("complexity") ?? "simple") as IdeaInput["complexity"],
      returnMode,
      returnDate: String(data.get("returnDate") ?? "") || null,
      returnWeeks: weeksText === "" ? null : Number(weeksText),
      complexDetails: {
        isMultiStage: triState("isMultiStage"),
        hasDeadline: triState("hasDeadline"),
        expectedResult: String(data.get("expectedResult") ?? ""),
        requiredResources: String(data.get("requiredResources") ?? ""),
        blockers: String(data.get("blockers") ?? ""),
        firstStep: String(data.get("firstStep") ?? ""),
        deadlineComment: String(data.get("deadlineComment") ?? ""),
      },
      subtasks: cloneSubtasks(subtasks),
      image,
    };
  }

  private renderSubtaskEditor(
    container: HTMLElement,
    subtasks: Subtask[],
    changed: () => void,
    reportLimit: (message: string) => void,
  ): void {
    container.replaceChildren();
    if (!subtasks.length) {
      const empty = document.createElement("p");
      empty.className = "subtask-empty";
      empty.textContent = "Подзадач пока нет.";
      container.append(empty);
      return;
    }
    subtasks.forEach((subtask, parentIndex) => {
      const group = document.createElement("div");
      group.className = "subtask-group";
      group.append(this.makeEditableSubtask(subtask, () => {
        subtasks.splice(parentIndex, 1);
        this.renderSubtaskEditor(container, subtasks, changed, reportLimit);
        changed();
      }, changed, "Подзадача"));
      const children = document.createElement("div");
      children.className = "nested-subtasks";
      subtask.children.forEach((child, childIndex) => children.append(this.makeEditableSubtask(child, () => {
        subtask.children.splice(childIndex, 1);
        this.renderSubtaskEditor(container, subtasks, changed, reportLimit);
        changed();
      }, changed, "Вложенная подзадача")));
      const addChild = document.createElement("button");
      addChild.type = "button";
      addChild.className = "text-button";
      addChild.textContent = "+ Вложенная подзадача";
      addChild.addEventListener("click", () => {
        if (subtask.children.length >= 20) {
          reportLimit("У одной подзадачи может быть не более 20 вложенных подзадач.");
          return;
        }
        if (subtask.children.length > 0 && leafSubtaskCount(subtasks) >= 500) {
          reportLimit("Можно добавить не более 500 конечных подзадач.");
          return;
        }
        subtask.children.push(createNestedSubtask());
        this.renderSubtaskEditor(container, subtasks, changed, reportLimit);
        changed();
      });
      children.append(addChild);
      group.append(children);
      container.append(group);
    });
  }

  private makeEditableSubtask(item: NestedSubtask, remove: () => void, changed: () => void, label: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "subtask-edit-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.completed;
    checkbox.setAttribute("aria-label", `Выполнена: ${item.title || label}`);
    checkbox.addEventListener("change", () => {
      item.completed = checkbox.checked;
      item.completedAt = checkbox.checked ? new Date().toISOString() : null;
      changed();
    });
    const fields = document.createElement("div");
    const title = document.createElement("input");
    title.value = item.title;
    title.maxLength = 200;
    title.placeholder = label;
    title.setAttribute("aria-label", `${label}: название`);
    title.addEventListener("input", () => { item.title = title.value; changed(); });
    const description = document.createElement("textarea");
    description.value = item.description;
    description.maxLength = 1000;
    description.rows = 2;
    description.placeholder = "Описание (необязательно)";
    description.setAttribute("aria-label", `${label}: описание`);
    description.addEventListener("input", () => { item.description = description.value; changed(); });
    fields.append(title, description);
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "icon-button icon-button--small";
    removeButton.setAttribute("aria-label", `Удалить: ${item.title || label}`);
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      if (!item.completed && !window.confirm("Удалить невыполненную подзадачу?")) return;
      remove();
    });
    row.append(checkbox, fields, removeButton);
    return row;
  }

  private renderDetailSubtasks(container: HTMLElement | null, idea: Idea, trigger: HTMLElement): void {
    if (!container) return;
    if (!idea.subtasks.length) {
      container.textContent = "Подзадач нет";
      return;
    }
    for (const subtask of idea.subtasks) {
      const group = document.createElement("div");
      group.className = "detail-subtask-group";
      group.append(this.makeDetailSubtask(subtask, idea, trigger));
      for (const child of subtask.children) group.append(this.makeDetailSubtask(child, idea, trigger, true));
      container.append(group);
    }
  }

  private makeDetailSubtask(item: NestedSubtask, idea: Idea, trigger: HTMLElement, nested = false): HTMLElement {
    const row = document.createElement("div");
    row.className = `detail-subtask${nested ? " detail-subtask--nested" : ""}`;
    const state = document.createElement("span");
    state.textContent = item.completed ? "✓" : "○";
    state.setAttribute("aria-label", item.completed ? "Выполнена" : "Не выполнена");
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.title;
    content.append(title);
    if (item.description) {
      const description = document.createElement("p");
      description.textContent = item.description;
      content.append(description);
    }
    const action = document.createElement("button");
    action.type = "button";
    action.className = "text-button";
    if (item.linkedIdeaId) {
      action.textContent = "Открыть отдельную идею";
      action.addEventListener("click", () => {
        this.dialog?.close();
        void this.openDetails(trigger, item.linkedIdeaId!);
      });
    } else {
      action.textContent = "Создать отдельную идею";
      action.addEventListener("click", async () => {
        const prefill = await this.service.makeLinkedPrefill(idea.id, item.id);
        this.dialog?.close();
        await this.openCreate(trigger, prefill.input, prefill.source);
      });
    }
    row.append(state, content, action);
    return row;
  }

  private updateSaveAvailability(form: HTMLFormElement): void {
    const title = (form.elements.namedItem("title") as HTMLInputElement).value.trim();
    const description = (form.elements.namedItem("description") as HTMLTextAreaElement).value.trim();
    const category = (form.elements.namedItem("categoryId") as HTMLSelectElement).value;
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (button) button.disabled = !title || !description || !category;
  }

  private showFormError(form: HTMLFormElement, error: unknown): void {
    this.clearError(form);
    const summary = form.querySelector<HTMLElement>(".error-summary");
    if (summary) {
      summary.hidden = false;
      summary.textContent = error instanceof Error ? error.message : "Не удалось сохранить идею.";
    }
    if (error instanceof UserInputError && error.field) {
      const field = form.elements.namedItem(error.field) as HTMLElement | null;
      field?.setAttribute("aria-invalid", "true");
      field?.focus();
      const message = document.createElement("span");
      message.className = "field-error";
      message.id = `field-error-${crypto.randomUUID()}`;
      message.textContent = error.message;
      field?.setAttribute("aria-describedby", [field.getAttribute("aria-describedby"), message.id].filter(Boolean).join(" "));
      field?.closest(".field")?.append(message);
    }
  }

  private clearError(form: HTMLFormElement): void {
    form.querySelectorAll("[aria-invalid='true']").forEach((field) => {
      field.removeAttribute("aria-invalid");
      const describedBy = field.getAttribute("aria-describedby")?.split(/\s+/).filter((id) => !id.startsWith("field-error-"));
      if (describedBy?.length) field.setAttribute("aria-describedby", describedBy.join(" "));
      else field.removeAttribute("aria-describedby");
    });
    form.querySelectorAll(".field-error").forEach((message) => message.remove());
    const summary = form.querySelector<HTMLElement>(".error-summary");
    if (summary) {
      summary.hidden = true;
      summary.textContent = "";
    }
  }

  private makeDialog(trigger: HTMLElement, className: string): HTMLDialogElement {
    this.dialog?.close();
    const dialog = document.createElement("dialog");
    dialog.className = `modal modal--wide ${className}`;
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
      if (document.contains(trigger)) trigger.focus();
    }, { once: true });
    document.body.append(dialog);
    this.dialog = dialog;
    return dialog;
  }

  private bindClose(dialog: HTMLDialogElement): void {
    dialog.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((button) =>
      button.addEventListener("click", () => dialog.close()),
    );
  }

  private showLightbox(dialog: HTMLDialogElement, url: string, alt: string): void {
    const overlay = document.createElement("div");
    overlay.className = "image-lightbox";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-button";
    close.setAttribute("aria-label", "Закрыть фотографию");
    close.textContent = "×";
    const image = document.createElement("img");
    image.src = url;
    image.alt = alt;
    overlay.append(close, image);
    close.addEventListener("click", () => overlay.remove());
    dialog.append(overlay);
    close.focus();
  }
}
