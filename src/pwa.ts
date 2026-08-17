export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type ErrorReporter = (error: unknown, operation: string) => void | Promise<void>;

export class PwaController {
  private installPrompt: InstallPromptEvent | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private updateReady = false;
  private installDismissed = false;
  private reloading = false;
  private errorReporter: ErrorReporter = () => undefined;
  private readonly region = document.createElement("aside");

  constructor() {
    this.region.className = "pwa-region";
    this.region.setAttribute("aria-live", "polite");
    this.region.setAttribute("aria-label", "Состояние приложения");
  }

  start(): void {
    document.body.append(this.region);
    window.addEventListener("beforeinstallprompt", this.handleInstallPrompt);
    window.addEventListener("appinstalled", this.handleInstalled);
    window.addEventListener("online", this.render);
    window.addEventListener("offline", this.render);
    if ("serviceWorker" in navigator && import.meta.env.PROD) {
      window.addEventListener("load", () => void this.registerServiceWorker(), { once: true });
    }
    this.render();
  }

  setErrorReporter(reporter: ErrorReporter): void {
    this.errorReporter = reporter;
  }

  openInstallInstructions(trigger: HTMLElement): void {
    const dialog = document.createElement("dialog");
    dialog.className = "modal install-dialog";
    dialog.innerHTML = `
      <div class="dialog-heading">
        <div><p class="eyebrow">Работа без сети</p><h2>Установка приложения</h2></div>
        <button class="icon-button" type="button" data-close aria-label="Закрыть">×</button>
      </div>
      <div class="about-copy">
        <p>После первого успешного открытия «Время идеи» работает без интернета. Для PWA нужен HTTPS или localhost.</p>
        <ol class="install-steps">
          <li><strong>Chrome или Edge:</strong> откройте меню браузера и выберите «Установить приложение».</li>
          <li><strong>Safari на iPhone или iPad:</strong> нажмите «Поделиться», затем «На экран Домой».</li>
          <li><strong>Другой браузер:</strong> найдите установку или добавление на главный экран в его меню. Если команды нет, используйте приложение во вкладке.</li>
        </ol>
      </div>
      <div class="dialog-actions">
        ${this.installPrompt ? '<button class="button button--primary" type="button" data-install>Установить приложение</button>' : ""}
        <button class="button button--secondary" type="button" data-close>Закрыть</button>
      </div>
    `;
    const close = (): void => dialog.close();
    dialog.querySelectorAll<HTMLElement>("[data-close]").forEach((button) => button.addEventListener("click", close));
    dialog.querySelector<HTMLButtonElement>("[data-install]")?.addEventListener("click", async () => {
      await this.requestInstall();
      if (dialog.open) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (document.contains(trigger)) trigger.focus();
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    (dialog.querySelector<HTMLElement>("[data-install]") ?? dialog.querySelector<HTMLElement>("[data-close]"))?.focus();
  }

  private readonly handleInstallPrompt = (event: Event): void => {
    event.preventDefault();
    this.installPrompt = event as InstallPromptEvent;
    this.installDismissed = false;
    this.render();
  };

  private readonly handleInstalled = (): void => {
    this.installPrompt = null;
    this.installDismissed = true;
    this.render();
  };

  private readonly render = (): void => {
    const offline = navigator.onLine === false;
    const install = this.installPrompt && !this.installDismissed;
    this.region.innerHTML = `
      ${offline ? '<section class="pwa-message"><span>Нет сети — доступны сохранённая оболочка и локальные данные.</span></section>' : ""}
      ${this.updateReady ? '<section class="pwa-message"><span>Доступна новая версия приложения.</span><button class="button button--small" type="button" data-pwa-update>Обновить</button><button class="icon-button icon-button--small" type="button" data-pwa-dismiss-update aria-label="Скрыть предложение обновления">×</button></section>' : ""}
      ${install ? '<section class="pwa-message"><span>Установите «Время идеи» для быстрого запуска.</span><button class="button button--small" type="button" data-pwa-install>Установить</button><button class="icon-button icon-button--small" type="button" data-pwa-dismiss-install aria-label="Скрыть предложение установки">×</button></section>' : ""}
    `;
    this.region.querySelector<HTMLButtonElement>("[data-pwa-install]")?.addEventListener("click", () => void this.requestInstall());
    this.region.querySelector<HTMLButtonElement>("[data-pwa-dismiss-install]")?.addEventListener("click", () => {
      this.installDismissed = true;
      this.render();
    });
    this.region.querySelector<HTMLButtonElement>("[data-pwa-update]")?.addEventListener("click", () => {
      this.registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    });
    this.region.querySelector<HTMLButtonElement>("[data-pwa-dismiss-update]")?.addEventListener("click", () => {
      this.updateReady = false;
      this.render();
    });
  };

  private async requestInstall(): Promise<void> {
    const prompt = this.installPrompt;
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") this.installPrompt = null;
    this.installDismissed = true;
    this.render();
  }

  private async registerServiceWorker(): Promise<void> {
    try {
      const serviceWorkerUrl = new URL("service-worker.js", document.baseURI);
      this.registration = await navigator.serviceWorker.register(serviceWorkerUrl, { scope: import.meta.env.BASE_URL });
      if (this.registration.waiting && navigator.serviceWorker.controller) {
        this.updateReady = true;
        this.render();
      }
      this.registration.addEventListener("updatefound", () => {
        const worker = this.registration?.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            this.updateReady = true;
            this.render();
          }
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (this.reloading) return;
        this.reloading = true;
        location.reload();
      });
    } catch (error) {
      await this.errorReporter(error, "registerServiceWorker");
      this.showRegistrationError();
    }
  }

  private showRegistrationError(): void {
    const message = document.createElement("section");
    message.className = "pwa-message pwa-message--error";
    message.setAttribute("role", "alert");
    message.innerHTML = '<span>Не удалось включить офлайн-режим. Проверьте подключение, откройте приложение через HTTPS или localhost и перезагрузите страницу.</span><button class="icon-button icon-button--small" type="button" aria-label="Закрыть сообщение">×</button>';
    message.querySelector("button")?.addEventListener("click", () => message.remove());
    this.region.append(message);
  }
}
