import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TechnicalReportService } from "../src/application/technical-report-service";
import { DATABASE_NAME } from "../src/domain/constants";
import { IdeaDatabase } from "../src/storage/database";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("технический отчёт", () => {
  let database: IdeaDatabase;

  beforeEach(async () => {
    await deleteDatabase();
    database = await IdeaDatabase.open();
  });

  afterEach(() => database.close());

  it("содержит только разрешённые обезличенные поля и очищается отдельно", async () => {
    await database.appendDiagnostic({
      occurredAt: "2026-08-18T10:00:00.000Z", appVersion: "0.1.0", browserType: "Test Browser",
      errorCode: "TEST", operation: "import https://secret.example/path", message: "PIN 1234\nНазвание идеи пользователя",
    });
    const service = new TechnicalReportService(database, () => new Date(2026, 7, 18, 12));
    const report = await service.createReport();
    expect(report.count).toBe(1);
    expect(report.text).not.toContain("1234");
    expect(report.text).not.toContain("https://");
    expect(Object.keys(JSON.parse(report.text).records[0])).toEqual(["occurredAt", "appVersion", "browserType", "errorCode", "operation", "message"]);
    await service.clear();
    expect((await service.createReport()).count).toBe(0);
  });
});
