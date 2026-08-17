import type { Category, Idea, Profile } from "../src/domain/types";

export function makeProfile(id = "profile-1"): Profile {
  return {
    id,
    name: `Профиль ${id}`,
    nameNormalized: `профиль ${id}`,
    pinHash: "hash",
    pinSalt: "salt",
    createdAt: "2026-08-17T10:00:00.000Z",
    settings: {
      theme: "light",
      view: "cards",
      filters: {},
      sortBy: "returnDate",
      sortDirection: "asc",
      notificationsEnabled: false,
      notifiedOn: {},
    },
    lastSuccessfulExportAt: null,
    photosSinceExport: 0,
    lastBackupReminderAt: null,
  };
}

export function makeCategory(profileId = "profile-1", id = "category-1"): Category {
  return {
    id,
    profileId,
    name: "Личное",
    nameNormalized: "личное",
    isSystem: true,
    systemKey: "personal",
    createdAt: "2026-08-17T10:00:00.000Z",
  };
}

export function makeIdea(profileId = "profile-1", id = "idea-1"): Idea {
  return {
    id,
    profileId,
    title: "Тестовая идея",
    description: "Краткое описание",
    notes: "",
    categoryId: "category-1",
    priority: "medium",
    complexity: "simple",
    status: "new",
    createdAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:00:00.000Z",
    returnDate: "2026-08-31",
    returnMode: "date",
    returnWeeks: null,
    recurrenceEligible: true,
    completedAt: null,
    rejectedAt: null,
    hasImage: false,
    complexDetails: {
      isMultiStage: null,
      expectedResult: "",
      requiredResources: "",
      blockers: "",
      firstStep: "",
      hasDeadline: null,
      deadlineComment: "",
    },
    subtasks: [],
    sourceIdeaId: null,
    sourceSubtaskId: null,
    sourceWasDeleted: false,
    statusHistory: [],
  };
}
