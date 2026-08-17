export type Priority = "low" | "medium" | "high";
export type Complexity = "simple" | "complex";
export type IdeaStatus =
  | "new"
  | "postponed"
  | "review"
  | "inProgress"
  | "completed"
  | "rejected";
export type ReturnMode = "date" | "weeks" | null;
export type StatusReason = "manual" | "date" | "restore";

export interface ProfileSettings {
  theme: "light" | "dark";
  view: "cards" | "list";
  filters: Record<string, string[]>;
  sortBy: "returnDate" | "priority" | "createdAt" | "updatedAt";
  sortDirection: "asc" | "desc";
  notificationsEnabled: boolean;
  notifiedOn?: Record<string, string>;
}

export interface Profile {
  id: string;
  name: string;
  nameNormalized: string;
  pinHash: string;
  pinSalt: string;
  createdAt: string;
  settings: ProfileSettings;
  lastSuccessfulExportAt: string | null;
  photosSinceExport: number;
  lastBackupReminderAt: string | null;
}

export interface Category {
  id: string;
  profileId: string;
  name: string;
  nameNormalized: string;
  isSystem: boolean;
  systemKey: "personal" | "work" | null;
  createdAt: string;
}

export interface StatusHistoryEntry {
  id: string;
  from: IdeaStatus;
  to: IdeaStatus;
  changedAt: string;
  reason: StatusReason;
}

export interface NestedSubtask {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
  linkedIdeaId: string | null;
}

export interface Subtask extends NestedSubtask {
  children: NestedSubtask[];
}

export interface ComplexDetails {
  isMultiStage: boolean | null;
  expectedResult: string;
  requiredResources: string;
  blockers: string;
  firstStep: string;
  hasDeadline: boolean | null;
  deadlineComment: string;
}

export interface Idea {
  id: string;
  profileId: string;
  title: string;
  description: string;
  notes: string;
  categoryId: string;
  priority: Priority;
  complexity: Complexity;
  status: IdeaStatus;
  createdAt: string;
  updatedAt: string;
  returnDate: string | null;
  returnMode: ReturnMode;
  returnWeeks: number | null;
  recurrenceEligible: boolean;
  completedAt: string | null;
  rejectedAt: string | null;
  hasImage: boolean;
  complexDetails: ComplexDetails;
  subtasks: Subtask[];
  sourceIdeaId: string | null;
  sourceSubtaskId: string | null;
  sourceWasDeleted: boolean;
  statusHistory: StatusHistoryEntry[];
}

export interface DraftImage {
  blob: Blob;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  savedAt: string;
}

export interface ImageRecord {
  ideaId: string;
  profileId: string;
  blob: Blob;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  savedAt: string;
}

export interface DraftRecord {
  id: string;
  profileId: string;
  formId: "draft_new" | `draft_edit_${string}`;
  data: Partial<Idea>;
  image: DraftImage | null;
  updatedAt: string;
}

export interface DiagnosticRecord {
  id?: number;
  occurredAt: string;
  appVersion: string;
  browserType: string;
  errorCode: string;
  operation: string;
  message: string;
}

export interface DatabaseMetadata {
  key: "database";
  schemaVersion: number;
  updatedAt: string;
}

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
  persistent: boolean | null;
}

export interface ProfileBundle {
  profile: Profile;
  categories: Category[];
  ideas: Idea[];
  images: ImageRecord[];
  drafts: DraftRecord[];
}
