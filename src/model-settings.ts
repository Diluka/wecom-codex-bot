export interface ReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly ReasoningEffortOption[];
}

export interface CodexSettings {
  model: string;
  effort: string | null;
}

export interface ConfigDefaults {
  model: string | null;
  effort: string | null;
}

export interface SettingsPatch {
  model?: string;
  effort?: string | null;
}

export interface CodexThreadSession {
  threadId: string;
  settings: CodexSettings;
}

export interface ModelSettingsSnapshot {
  settings: CodexSettings;
  selectedModel: CodexModel;
  models: readonly CodexModel[];
  source: "thread" | "default";
}

export type ModelSettingsUpdateResult =
  | {
    status: "updated";
    settings: CodexSettings;
    threadUpdated: boolean;
    defaultPersisted: boolean;
    effortAdjusted: boolean;
    persistenceError?: string;
  }
  | {
    status: "invalid_model";
    availableModels: readonly string[];
  }
  | {
    status: "invalid_effort";
    model: string;
    availableEfforts: readonly string[];
  };
