export const LIMITS = Object.freeze({
  ideasPerProfile: 2_000,
  firstLevelSubtasksPerIdea: 100,
  nestedSubtasksPerSubtask: 20,
  leafSubtasksPerIdea: 500,
  statusHistoryPerIdea: 100,
  userCategoriesPerProfile: 100,
  ideasWithImagesPerProfile: 25,
  imageBytesPerProfile: 25 * 1024 * 1024,
  imageBytesPerIdea: 1024 * 1024,
  diagnostics: 50,
});

export const DATABASE_NAME = "vremya-idei";
export const SCHEMA_VERSION = 2;

export const SYSTEM_CATEGORY_NAMES = ["Личное", "Работа"] as const;
export const WELCOME_FLAG_KEY = "vremya-idei:welcome-viewed";
export const THEME_FLAG_KEY = "vremya-idei:theme";

export const BACKUP_LIMITS = Object.freeze({
  warningBytes: 20 * 1024 * 1024,
  maximumExportBytes: 40 * 1024 * 1024,
  maximumImportBytes: 50 * 1024 * 1024,
});
