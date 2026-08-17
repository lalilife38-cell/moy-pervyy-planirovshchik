import { compareCalendarDates, toLocalCalendarDate } from "../domain/dates";
import type { Idea } from "../domain/types";
import { UserInputError, ProfileService } from "./profile-service";

export interface NotificationHandle {
  onClick(handler: () => void): void;
  close(): void;
}

export interface NotificationGateway {
  supported: boolean;
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  show(title: string, options: NotificationOptions): NotificationHandle;
}

export const browserNotificationGateway: NotificationGateway = {
  get supported() { return "Notification" in globalThis; },
  get permission() { return "Notification" in globalThis ? Notification.permission : "denied"; },
  async requestPermission() { return Notification.requestPermission(); },
  show(title, options) {
    const notification = new Notification(title, options);
    return {
      onClick(handler) { notification.onclick = handler; },
      close() { notification.close(); },
    };
  },
};

export class NotificationService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly openIdea: (ideaId: string) => void,
    private readonly gateway: NotificationGateway = browserNotificationGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get supported(): boolean { return this.gateway.supported; }
  get permission(): NotificationPermission { return this.gateway.permission; }

  async enable(): Promise<NotificationPermission> {
    if (!this.gateway.supported) throw new UserInputError("Этот браузер не поддерживает локальные уведомления.");
    const permission = await this.gateway.requestPermission();
    await this.profiles.updateNotificationSettings(permission === "granted");
    return permission;
  }

  async disable(): Promise<void> {
    await this.profiles.updateNotificationSettings(false);
  }

  showTest(): void {
    if (!this.gateway.supported || this.gateway.permission !== "granted") {
      throw new UserInputError("Сначала разрешите уведомления в браузере.");
    }
    this.gateway.show("Время идеи — Тест", {
      body: "Тестовое уведомление работает. Фоновая доставка при закрытом браузере не гарантируется.",
      tag: "vremya-idei-test",
    });
  }

  async checkDueIdeas(ideas: Idea[]): Promise<number> {
    const settings = this.profiles.getCurrentSettings();
    const now = this.now();
    if (!settings.notificationsEnabled || !this.gateway.supported || this.gateway.permission !== "granted" || now.getHours() < 9) return 0;
    const today = toLocalCalendarDate(now);
    const log = { ...(settings.notifiedOn ?? {}) };
    const due = ideas.filter((idea) =>
      !["completed", "rejected"].includes(idea.status) && idea.returnDate !== null &&
      compareCalendarDates(idea.returnDate, today) <= 0 && log[idea.id] !== today,
    );
    for (const idea of due) {
      const notification = this.gateway.show("Время вернуться к идее", {
        body: idea.title,
        tag: `vremya-idei-${idea.id}-${today}`,
        data: { ideaId: idea.id },
      });
      notification.onClick(() => {
        globalThis.focus?.();
        this.openIdea(idea.id);
        notification.close();
      });
      log[idea.id] = today;
    }
    if (due.length) await this.profiles.updateNotificationSettings(true, log);
    return due.length;
  }
}
