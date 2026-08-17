export type StorageErrorCode =
  | "STORAGE_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "VALIDATION_FAILED"
  | "LIMIT_REACHED"
  | "CORRUPTED_DATA"
  | "UNKNOWN_SCHEMA"
  | "TRANSACTION_FAILED";

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
    public readonly operation: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}

export function normalizeStorageError(error: unknown, operation: string): StorageError {
  if (error instanceof StorageError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new StorageError(
      "QUOTA_EXCEEDED",
      "В локальном хранилище недостаточно места.",
      operation,
      { cause: error },
    );
  }
  return new StorageError(
    "TRANSACTION_FAILED",
    "Не удалось завершить операцию с локальными данными.",
    operation,
    { cause: error },
  );
}

export function explainStorageError(error: unknown): string {
  const normalized = normalizeStorageError(error, "startup");
  switch (normalized.code) {
    case "STORAGE_UNAVAILABLE":
      return "Локальное хранилище недоступно. Разрешите хранение данных для этого сайта и перезагрузите страницу.";
    case "QUOTA_EXCEEDED":
      return "В браузере недостаточно места. Освободите хранилище и попробуйте снова.";
    case "UNKNOWN_SCHEMA":
      return "Данные созданы более новой версией приложения. Обновите приложение, не очищая данные сайта.";
    case "CORRUPTED_DATA":
      return "Часть локальных данных повреждена. Не очищайте сайт; сохраните технический отчёт для диагностики.";
    default:
      return "Не удалось открыть локальные данные. Проверьте настройки хранения браузера и перезагрузите страницу.";
  }
}
