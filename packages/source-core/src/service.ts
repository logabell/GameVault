import type {
  ParsedSourcePayload,
  SourceSnapshot,
  SupportedSourceKind,
} from '@vaulttrack/shared-types';

import { elAmigosAdapter } from './adapters/elamigos.js';
import { steamRipAdapter } from './adapters/steamrip.js';
import type { RefreshTrackedItemInput, SourceAdapter } from './types.js';

const adapters: SourceAdapter[] = [elAmigosAdapter, steamRipAdapter];

export function getAdapterForUrl(url: string, html: string): SourceAdapter | null {
  return adapters.find((adapter) => adapter.detectPage(url, html)) ?? null;
}

export function getAdapterForKind(
  sourceKind: SupportedSourceKind,
): SourceAdapter | null {
  return adapters.find((adapter) => adapter.kind === sourceKind) ?? null;
}

export function parseSupportedPage(url: string, html: string): ParsedSourcePayload {
  const adapter = getAdapterForUrl(url, html);
  if (!adapter) {
    throw new Error(`No source adapter matched ${url}`);
  }

  return adapter.parsePage(url, html);
}

export function parseSupportedPageForKind(
  sourceKind: SupportedSourceKind,
  url: string,
  html: string,
): ParsedSourcePayload {
  const adapter = getAdapterForKind(sourceKind);
  if (!adapter) {
    throw new Error(`No source adapter found for ${sourceKind}`);
  }

  return adapter.parsePage(url, html);
}

export function refreshTrackedItemFromHtml(
  item: RefreshTrackedItemInput,
  html: string,
): SourceSnapshot {
  const adapter = getAdapterForKind(item.sourceKind);
  if (!adapter) {
    throw new Error(`No source adapter found for ${item.sourceKind}`);
  }

  return adapter.refreshTrackedItem(item, html);
}

export function getSupportedSourceKinds(): SupportedSourceKind[] {
  return adapters.map((adapter) => adapter.kind);
}
