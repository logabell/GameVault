export type SupportedSourceKind = 'ankergames' | 'elamigos' | 'steamrip';
export type SourceKind = SupportedSourceKind | 'manual';

export type ItemActionStatus = 'idle' | 'pending' | 'complete' | 'failed';

export enum TrackedItemStatus {
  New = 'new',
  Queued = 'queued',
  Downloading = 'downloading',
  Extracting = 'extracting',
  Staged = 'staged',
  Installed = 'installed',
  FolderMissing = 'folder_missing',
  Failed = 'failed',
}

export enum TrackedItemTrackingStatus {
  NeedsMatch = 'needs_match',
  WatchWindowExpired = 'watch_window_expired',
  UpdateAvailable = 'update_available',
  SourceBehindUpstream = 'source_behind_upstream',
  UpToDate = 'up_to_date',
  WatchingSource = 'watching_source',
}

export interface ReleaseDescriptor {
  version: string;
  buildId?: string | null;
  patchDate?: string | null;
  label: string;
  isPatch: boolean;
}

export interface DownloadDescriptor {
  url: string;
  label: string;
  kind: 'full' | 'patch';
}

export type HealthColor = 'green' | 'yellow' | 'red';

export interface HealthIndicator {
  color: HealthColor;
  label: string;
  message: string;
}

export interface MyJDownloaderDeviceSummary {
  id: string;
  name: string;
  status: string;
  selected: boolean;
}

export interface ConnectionHealthSummary {
  desktop: HealthIndicator;
  myJDownloader: HealthIndicator;
  devices: MyJDownloaderDeviceSummary[];
  selectedDeviceId?: string | null;
}

export interface ParsedSourcePayload {
  sourceKind: SupportedSourceKind;
  sourceUrl: string;
  title: string;
  normalizedTitle: string;
  coverUrl?: string | null;
  fingerprint: string;
  latestSourceRelease: ReleaseDescriptor;
  fullRelease?: ReleaseDescriptor | null;
  fullDownloadUrls: DownloadDescriptor[];
  patchDownloadUrls: DownloadDescriptor[];
  notes?: string[];
}

export interface SteamCandidate {
  appId: number;
  title: string;
  normalizedTitle: string;
  coverUrl?: string | null;
  releaseDate?: string | null;
  score: number;
  reasons: string[];
  matchedQuery?: string | null;
  source?: string | null;
}

export interface ConfirmedSteamMatch {
  appId: number;
  title: string;
  normalizedTitle: string;
  coverUrl?: string | null;
  matchedAt: string;
}

export interface InstallRecord {
  trackedItemId: string;
  installedVersion?: string | null;
  installedBuildId?: string | null;
  installedAt?: string | null;
  installPath?: string | null;
  updatedAt: string;
}

export interface SourceSnapshot {
  trackedItemId: string;
  sourceKind: SourceKind;
  sourceUrl: string;
  fingerprint: string;
  observedVersion: string;
  observedBuildId?: string | null;
  observedPatchDate?: string | null;
  observedPatchLink?: string | null;
  observedPatchTitle?: string | null;
  patchSelectionSource?: PatchSelectionSource | null;
  checkedAt: string;
}

export type PatchSelectionSource = 'rss' | 'steamdb_builds' | 'manual';

export interface SteamPatchCandidate {
  appId: number;
  title: string;
  patchTitle: string;
  description?: string | null;
  version?: string | null;
  buildId?: string | null;
  patchDate: string;
  publishedAt: string;
  link: string;
  selectionSource?: PatchSelectionSource | null;
}

export interface SteamPatchEntry extends SteamPatchCandidate {
  trackedItemId: string;
}

export interface SteamPatchFeedResult {
  appId: number;
  feedUrl: string;
  fetchedAt: string;
  patches: SteamPatchCandidate[];
}

export interface SteamFeedCheckRecord {
  trackedItemId: string;
  feedUrl?: string | null;
  lastCheckedAt?: string | null;
  lastSuccessfulAt?: string | null;
  lastError?: string | null;
  updatedAt: string;
}

export interface SourceWatch {
  trackedItemId: string;
  startedAt: string;
  endsAt: string;
  nextCheckAt: string;
  lastCheckedAt?: string | null;
  expiredAt?: string | null;
}

export type DownloadStage =
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'staged'
  | 'failed'
  | 'complete';

export interface DownloadJobPartRecord {
  id: string;
  jobId: string;
  trackedItemId: string;
  role: 'full' | 'patch';
  packageName: string;
  mirrorUrl?: string | null;
  stage: DownloadStage;
  packageId?: number | null;
  bytesLoaded?: number | null;
  bytesTotal?: number | null;
  speed?: number | null;
  etaSeconds?: number | null;
  statusMessage?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadJobRecord {
  id: string;
  trackedItemId: string;
  packageName: string;
  stagePath: string;
  finalPath: string;
  stage: DownloadStage;
  selectedMirrorUrl?: string | null;
  selectedPatchMirrorUrl?: string | null;
  packageId?: number | null;
  bytesLoaded?: number | null;
  bytesTotal?: number | null;
  speed?: number | null;
  etaSeconds?: number | null;
  statusMessage?: string | null;
  completedParts?: number | null;
  totalParts?: number | null;
  parts?: DownloadJobPartRecord[];
  createdAt: string;
  updatedAt: string;
  errorMessage?: string | null;
}

export interface DownloadMirrorRecord {
  trackedItemId: string;
  url: string;
  label: string;
  kind: 'full' | 'patch';
  selectedAt?: string | null;
  manuallyFailedAt?: string | null;
  lastSeenAt: string;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface LibraryRootRecord {
  id: string;
  path: string;
  label: string;
  isPrimary: boolean;
}

export interface IgnoredImportFolderRecord {
  id: string;
  folderName: string;
  ignoredAt: string;
  rootPath: string;
}

export interface SettingsRecord {
  rootLibraryPath?: string | null;
  libraryRoots?: LibraryRootRecord[];
  renameGameFoldersOnImport?: boolean;
  ignoredImportFolders?: IgnoredImportFolderRecord[];
  myJDownloaderEmail?: string | null;
  myJDownloaderDeviceId?: string | null;
  pollDailyHourLocal?: number;
  themeMode?: ThemeMode | null;
}

export interface SettingsView extends SettingsRecord {
  myJDownloaderPasswordConfigured: boolean;
}

export interface EventLogRecord {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
  createdAt: string;
}

export interface TrackedItemRecord {
  id: string;
  title: string;
  normalizedTitle: string;
  sourceKind?: SourceKind | null;
  sourceUrl?: string | null;
  coverUrl?: string | null;
  steamAppId?: number | null;
  steamTitle?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackedItemActivity {
  lastSteamFeedCheckedAt?: string | null;
  lastSteamFeedError?: string | null;
  steamFeedUrl?: string | null;
  lastSourceScannedAt?: string | null;
  lastSourceWatchCheckedAt?: string | null;
  nextSourceWatchCheckAt?: string | null;
}

export interface TrackedItemFileState {
  finalPath?: string | null;
  finalPathExists: boolean;
  stagePath?: string | null;
}

export interface TrackedItemView {
  item: TrackedItemRecord;
  sourceSnapshot?: SourceSnapshot | null;
  installRecord?: InstallRecord | null;
  currentWatch?: SourceWatch | null;
  latestPatch?: SteamPatchEntry | null;
  selectedPatch?: SteamPatchEntry | null;
  selectedPatchMissingFromFeed?: boolean;
  versionsBehindLatest?: number | null;
  currentDownload?: DownloadJobRecord | null;
  downloadMirrors: DownloadMirrorRecord[];
  selectedMirror?: DownloadMirrorRecord | null;
  status: TrackedItemStatus;
  trackingStatus: TrackedItemTrackingStatus;
  activity: TrackedItemActivity;
  fileState: TrackedItemFileState;
}

export interface SelectedDownloads {
  fullUrl: string;
  patchUrl?: string | null;
}

export interface AddTrackedItemRequestPayload {
  parsedSource: ParsedSourcePayload;
  steamMatch: ConfirmedSteamMatch | null;
  selectedSteamPatch: SteamPatchCandidate | null;
  steamPatchEntries?: SteamPatchCandidate[] | null;
  selectedDownloads: SelectedDownloads;
  queueDownload: boolean;
}

export interface SteamMatchResolutionPayload {
  queryTitle: string;
  sourceKind: SourceKind;
  sourceUrl: string | null;
  candidates: SteamCandidate[];
  autoSelected: boolean;
  searchQueries?: string[];
}

export interface ImportCandidateDuplicate {
  trackedItemId: string;
  title: string;
  installPath?: string | null;
}

export interface ImportCandidate {
  autoSelectedSteamMatch?: ConfirmedSteamMatch | null;
  duplicateSteamMatch?: ImportCandidateDuplicate | null;
  folderName: string;
  folderPath: string;
  id: string;
  ignored: boolean;
  normalizedTitle: string;
  rootId: string;
  rootLabel: string;
  rootPath: string;
  steamCandidates: SteamCandidate[];
  title: string;
}

export interface ImportScanPayload {
  includeIgnored?: boolean;
  rootIds?: string[] | null;
}

export interface IgnoreImportFolderPayload {
  folderName: string;
  rootPath: string;
}

export interface RestoreImportFolderPayload {
  id: string;
}

export interface SaveImportBatchRow {
  allowDuplicateSteamApp?: boolean;
  folderName: string;
  folderPath: string;
  installedAt?: string | null;
  installedBuildId?: string | null;
  installedVersion?: string | null;
  renameFolder?: boolean;
  rootId?: string | null;
  rootPath: string;
  selectedSteamPatch: SteamPatchCandidate;
  steamMatch: ConfirmedSteamMatch;
  steamPatchEntries?: SteamPatchCandidate[] | null;
}

export interface SaveImportBatchPayload {
  rows: SaveImportBatchRow[];
}

export interface SaveImportBatchResult {
  imported: TrackedItemView[];
}

export type SteamDbBuildLookupStatus = 'pending' | 'complete' | 'failed';
export type SteamDbBuildLookupFailureKind =
  | 'cloudflare'
  | 'load_failed'
  | 'rate_limited'
  | 'timeout'
  | 'unknown';
export type SteamDbBuildLookupAttentionKind = 'cloudflare';

export interface SteamDbBuildLookupState {
  attentionKind?: SteamDbBuildLookupAttentionKind | null;
  appId: number;
  completedAt?: string | null;
  createdAt: string;
  errorKind?: SteamDbBuildLookupFailureKind | null;
  errorMessage?: string | null;
  id: string;
  needsUserAttention?: boolean | null;
  patches: SteamPatchCandidate[];
  retryAfterMs?: number | null;
  status: SteamDbBuildLookupStatus;
  updatedAt: string;
}

export interface CompleteSteamDbBuildLookupPayload {
  attentionKind?: SteamDbBuildLookupAttentionKind | null;
  appId: number;
  errorKind?: SteamDbBuildLookupFailureKind | null;
  errorMessage?: string | null;
  lookupId: string;
  needsUserAttention?: boolean | null;
  patches?: SteamPatchCandidate[] | null;
  retryAfterMs?: number | null;
}

export interface CacheSteamDbBuildLookupPayload {
  appId: number;
  patches: SteamPatchCandidate[];
}

export interface UpdateSteamDbBuildLookupPayload {
  attentionKind?: SteamDbBuildLookupAttentionKind | null;
  appId: number;
  errorMessage?: string | null;
  lookupId: string;
  needsUserAttention?: boolean | null;
}

export interface RefreshResult {
  snapshot: SourceSnapshot;
  latestPatch?: SteamPatchEntry | null;
  status: TrackedItemStatus;
  trackingStatus: TrackedItemTrackingStatus;
}

export type RemoveTrackedItemMode = 'tracking_only' | 'delete_files';

export interface RemoveTrackedItemPayload {
  trackedItemId: string;
  mode: RemoveTrackedItemMode;
}

export interface RemoveTrackedItemResult {
  removed: true;
  trackedItemId: string;
  mode: RemoveTrackedItemMode;
}
