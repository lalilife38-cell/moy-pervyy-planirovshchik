import "./style.css";
import { PwaController } from "./pwa";
import { IdeaDatabase } from "./storage/database";
import { Application, renderStorageFailure } from "./ui/app";

const rootElement = document.querySelector<HTMLDivElement>("#app");

if (!rootElement) {
  throw new Error("Не найден корневой элемент приложения");
}

const root: HTMLDivElement = rootElement;
const pwa = new PwaController();
pwa.start();

async function start(): Promise<void> {
  try {
    const database = await IdeaDatabase.open();
    pwa.setErrorReporter((error, operation) => database.logError(error, operation));
    const application = new Application(root, database, pwa);
    application.start();
    window.addEventListener("pagehide", () => application.destroy(), { once: true });
  } catch (error) {
    renderStorageFailure(root, error);
  }
}

void start();
