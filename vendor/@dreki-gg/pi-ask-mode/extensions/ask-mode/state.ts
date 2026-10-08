import { STATE_ENTRY } from './constants.js';

export interface PersistedState {
  askEnabled: boolean;
}

export interface StateEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

function isPersistedState(value: unknown): value is PersistedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'askEnabled' in value &&
    typeof value.askEnabled === 'boolean'
  );
}

export function findSavedAskState(entries: StateEntry[]): boolean | undefined {
  let saved: boolean | undefined;

  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY) continue;
    if (!isPersistedState(entry.data)) continue;
    saved = entry.data.askEnabled;
  }

  return saved;
}
