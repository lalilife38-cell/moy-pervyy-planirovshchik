import { IdeaDatabase } from "../storage/database";

export class TechnicalReportService {
  constructor(private readonly database: IdeaDatabase, private readonly now: () => Date = () => new Date()) {}

  async createReport(): Promise<{ text: string; filename: string; count: number }> {
    const records = (await this.database.listDiagnostics()).slice(-50).map((record) => ({
      occurredAt: record.occurredAt,
      appVersion: record.appVersion,
      browserType: record.browserType,
      errorCode: record.errorCode,
      operation: record.operation,
      message: record.message,
    }));
    return {
      text: JSON.stringify({ app: "Время идеи", generatedAt: this.now().toISOString(), records }, null, 2),
      filename: `vremya-idei_diagnostics_${this.now().toLocaleDateString("sv-SE")}.json`,
      count: records.length,
    };
  }

  async clear(): Promise<void> {
    await this.database.clearDiagnostics();
  }
}
