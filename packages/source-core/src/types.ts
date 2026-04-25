import type {
  ParsedSourcePayload,
  SourceSnapshot,
  SupportedSourceKind,
} from '@gamevault/shared-types';

export interface RefreshTrackedItemInput {
  trackedItemId: string;
  sourceKind: SupportedSourceKind;
  sourceUrl: string;
}

export interface SourceAdapter {
  readonly kind: SupportedSourceKind;
  detectPage(url: string, html: string): boolean;
  parsePage(url: string, html: string): ParsedSourcePayload;
  refreshTrackedItem(
    item: RefreshTrackedItemInput,
    html: string,
  ): SourceSnapshot;
}
