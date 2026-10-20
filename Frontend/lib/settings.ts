"use client";

import { SETTINGS_STORAGE_KEY, DEFAULT_THEME, normalizeTheme, type Theme } from "./theme";

export type PersistenceStatus = "not-saved" | "persisted" | "session-only";

function reportError(message: string, error: unknown): void {
  try { console.error(message, error); } catch { /* Logging must not interrupt delivery. */ }
}

export interface UserSettings {
  theme: Theme;
  language: string;
  currency: string;
  dateFormat: string;
  timeFormat: "12h" | "24h";
  notifications: {
    email: boolean;
    push: boolean;
    priceAlerts: boolean;
    marketUpdates: boolean;
    tradeConfirmations: boolean;
    newsletter: boolean;
  };
  trading: {
    defaultSlippage: number;
    confirmTransactions: boolean;
    showAdvancedOptions: boolean;
    autoApprove: boolean;
    gasPreference: "slow" | "standard" | "fast";
  };
  privacy: {
    showProfile: boolean;
    showPortfolio: boolean;
    showActivity: boolean;
    analyticsEnabled: boolean;
  };
  display: {
    compactMode: boolean;
    showBalances: boolean;
    animationsEnabled: boolean;
    soundEnabled: boolean;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: DEFAULT_THEME,
  language: "en",
  currency: "USD",
  dateFormat: "MM/DD/YYYY",
  timeFormat: "12h",
  notifications: {
    email: true,
    push: true,
    priceAlerts: true,
    marketUpdates: true,
    tradeConfirmations: true,
    newsletter: false,
  },
  trading: {
    defaultSlippage: 0.5,
    confirmTransactions: true,
    showAdvancedOptions: false,
    autoApprove: false,
    gasPreference: "standard",
  },
  privacy: {
    showProfile: false,
    showPortfolio: false,
    showActivity: false,
    analyticsEnabled: true,
  },
  display: {
    compactMode: false,
    showBalances: true,
    animationsEnabled: true,
    soundEnabled: true,
  },
};

const STORAGE_KEY = SETTINGS_STORAGE_KEY;

/**
 * Single merge point for settings coming from persistence, so the initial
 * load, JSON import, and cross-tab `storage` events all reuse the same
 * validation and merging before any subscriber is notified.
 */
function mergePersistedSettings(parsed: unknown): UserSettings {
  const source: Record<string, unknown> =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return { ...DEFAULT_SETTINGS, ...source, theme: normalizeTheme(source.theme) };
}

export class SettingsService {
  private persistenceStatus: PersistenceStatus = "not-saved";
  private persistenceListeners = new Set<(status: PersistenceStatus) => void>();
  private settings: UserSettings = DEFAULT_SETTINGS;
  private listeners: Set<(settings: UserSettings) => void> = new Set();
  private storageListener: ((event: StorageEvent) => void) | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          this.settings = mergePersistedSettings(JSON.parse(stored));
          this.persistenceStatus = "persisted";
        }
      } catch (e) {
        this.persistenceStatus = "session-only";
        reportError("Failed to load settings from localStorage", e);
      }
      this.registerStorageListener();
    }
  }

  getSettings(): UserSettings {
    return this.settings;
  }

  getSetting<K extends keyof UserSettings>(key: K): UserSettings[K] {
    return this.settings[key];
  }

  updateSettings(updates: Partial<UserSettings>): void {
    this.settings = { ...this.settings, ...updates };
    this.saveAndNotify();
  }

  updateNestedSetting<K extends keyof UserSettings>(
    category: K,
    updates: Partial<UserSettings[K]>
  ): void {
    this.settings = {
      ...this.settings,
      [category]: {
        ...(this.settings[category] as any),
        ...(updates as any),
      },
    };
    this.saveAndNotify();
  }

  resetSettings(): void {
    this.settings = DEFAULT_SETTINGS;
    this.saveAndNotify();
  }

  resetCategory<K extends keyof UserSettings>(category: K): void {
    this.settings = {
      ...this.settings,
      [category]: DEFAULT_SETTINGS[category],
    };
    this.saveAndNotify();
  }

  exportSettings(): string {
    return JSON.stringify(this.settings, null, 2);
  }

  importSettings(json: string): boolean {
    try {
      const parsed = JSON.parse(json);
      // Basic structural validation
      if (parsed && typeof parsed === "object") {
        this.settings = mergePersistedSettings(parsed);
        this.saveAndNotify();
        return true;
      }
      return false;
    } catch (e) {
      reportError("Failed to import settings", e);
      return false;
    }
  }

  subscribe(listener: (settings: UserSettings) => void): () => void {
    this.listeners.add(listener);
    // Emit initial value
    this.notify(listener, this.settings);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getPersistenceStatus(): PersistenceStatus {
    return this.persistenceStatus;
  }

  subscribePersistence(listener: (status: PersistenceStatus) => void): () => void {
    this.persistenceListeners.add(listener);
    this.notify(listener, this.persistenceStatus);
    return () => { this.persistenceListeners.delete(listener); };
  }

  private notify<T>(listener: (value: T) => void, value: T): void {
    try { listener(value); }
    catch (error) { reportError("Settings subscriber failed", error); }
  }

  private saveAndNotify(): void {
    let status: PersistenceStatus = "session-only";
    try {
      if (typeof window === "undefined") throw new Error("Browser storage is unavailable");
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      status = "persisted";
    } catch (error) {
      reportError("Failed to save settings to localStorage", error);
    }
    if (status !== this.persistenceStatus) {
      this.persistenceStatus = status;
      this.persistenceListeners.forEach((listener) => this.notify(listener, status));
    }
    this.listeners.forEach((listener) => this.notify(listener, this.settings));
  }

  /**
   * Cross-tab synchronization (FE-014): the browser fires a `storage` event in
   * every *other* tab whenever this tab's localStorage entry is written, and it
   * never fires in the tab that performed the write. Listening here lets each
   * tab apply the remote value without re-saving it, which is what keeps the
   * propagation free of echo loops and duplicate saves.
   */
  private registerStorageListener(): void {
    if (typeof window.addEventListener !== "function") return;
    this.storageListener = (event: StorageEvent) => this.handleStorageEvent(event);
    try {
      window.addEventListener("storage", this.storageListener);
    } catch (error) {
      reportError("Failed to register the cross-tab settings listener", error);
      this.storageListener = null;
    }
  }

  private handleStorageEvent(event: StorageEvent): void {
    try {
      // Unrelated keys and non-localStorage areas (e.g. sessionStorage or
      // synthetic events without a storage area) must not trigger updates.
      if (event.key !== STORAGE_KEY) return;
      if (event.storageArea !== window.localStorage) return;

      let next: UserSettings;
      if (event.newValue === null) {
        // Another tab removed the key; fall back to the defaults like a fresh load.
        next = { ...DEFAULT_SETTINGS };
      } else {
        next = mergePersistedSettings(JSON.parse(event.newValue));
      }
      this.applyRemoteSettings(next);
    } catch (error) {
      // A malformed remote payload must never corrupt local state.
      reportError("Failed to apply cross-tab settings update", error);
    }
  }

  /**
   * Applies a value persisted by another tab. Deliberately does NOT write back
   * to localStorage (the value is already there) and does not touch the
   * persistence status, which tracks this tab's own save capability.
   */
  private applyRemoteSettings(next: UserSettings): void {
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.settings = next;
    this.listeners.forEach((listener) => this.notify(listener, this.settings));
  }
}

export const settingsService = new SettingsService();

export const settingsValidation = {
  slippage: (value: number): true | string => {
    if (isNaN(value)) return "Slippage must be a number";
    if (value < 0.1 || value > 50) {
      return "Slippage must be between 0.1% and 50%";
    }
    return true;
  },
  language: (value: string): true | string => {
    const validLanguages = ["en", "es", "fr", "de", "zh", "ja"];
    if (!validLanguages.includes(value)) {
      return "Unsupported language";
    }
    return true;
  },
  currency: (value: string): true | string => {
    const validCurrencies = ["USD", "EUR", "GBP", "JPY", "CNY"];
    if (!validCurrencies.includes(value)) {
      return "Unsupported currency";
    }
    return true;
  },
};
