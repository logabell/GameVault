export type SupportedSourceKind = 'ankergames' | 'elamigos' | 'steamrip';
export type SourceKind = SupportedSourceKind | 'manual';

export type ItemActionStatus = 'idle' | 'pending' | 'complete' | 'failed';

export enum TrackedItemStatus {
  New = 'new',
  Discovered = 'discovered',
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
  browserDownloadUrl?: string | null;
  label: string;
  kind: 'full' | 'patch';
}

export type OnlineFixMode = 'included' | 'separate';
export type OnlineFixIconColor = 'green' | 'red';
export type OnlineFixLibraryStatus =
  | 'enabled'
  | 'available_missing'
  | 'downloading'
  | 'failed'
  | 'none';

export interface OnlineFixDownloadDescriptor {
  url: string;
  browserDownloadUrl?: string | null;
  label: string;
}

export interface OnlineFixSourceInfo {
  detected: boolean;
  mode: OnlineFixMode;
  downloadUrls: OnlineFixDownloadDescriptor[];
  evidence: string[];
  detectedAt?: string | null;
}

export interface OnlineFixLibraryState {
  status: OnlineFixLibraryStatus;
  iconColor?: OnlineFixIconColor | null;
  mode?: OnlineFixMode | null;
  sourceKind?: SupportedSourceKind | null;
  sourceUrl?: string | null;
  folderPath?: string | null;
  downloadUrl?: string | null;
  lastError?: string | null;
  evidence?: string[];
  detectedAt?: string | null;
  updatedAt?: string | null;
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

export interface DesktopHealthSummary {
  extension: HealthIndicator;
  jDownloader: HealthIndicator;
  lastExtensionActivityAt?: string | null;
  overall: HealthIndicator;
}

export const FIREFOX_EXTENSION_ID = 'gamevault@vaulttrack.local';

export type BrowserTarget = 'chrome' | 'edge' | 'firefox';

export interface BrowserExtensionInstall {
  browser: BrowserTarget;
  enabled: boolean;
  extensionId: string;
  installPath?: string | null;
  manifestName?: string | null;
  preferencesPath: string;
  profileName: string;
  state?: number | null;
}

export interface BrowserExtensionInstallStatus {
  checkedAt: string;
  detected: boolean;
  enabled: boolean;
  installations: BrowserExtensionInstall[];
  message: string;
}

export interface JDownloaderInstallStatus {
  checkedAt: string;
  detected: boolean;
  installPath?: string | null;
  installed: boolean;
  message: string;
  running: boolean;
  source?: 'known-path' | 'process' | 'where' | null;
}

export interface NativeHostRegistrationMetadata {
  browsers: BrowserTarget[];
  extensionId: string;
  manifestPath: string;
  manifestPaths?: Partial<Record<BrowserTarget, string>>;
  registeredAt: string;
}

export interface NativeHostRegistrationResult extends NativeHostRegistrationMetadata {
  launcherPath: string;
}

export interface ExtensionSetupInfo {
  browsers: BrowserTarget[];
  extensionPath: string;
  extensionPathExists: boolean;
  firefoxExtensionId?: string;
  nativeHostName: string;
}

export interface RegisterExtensionNativeHostPayload {
  browsers: BrowserTarget[];
  extensionId: string;
}

export interface OnboardingState {
  completedAt?: string | null;
  extensionConfirmedAt?: string | null;
  extensionRegistration?: NativeHostRegistrationMetadata | null;
  extensionRegistrations?: Partial<
    Record<BrowserTarget, NativeHostRegistrationMetadata>
  > | null;
  extensionSkippedAt?: string | null;
  jDownloaderConfirmedAt?: string | null;
  jDownloaderSkippedAt?: string | null;
  myJDownloaderConfirmedAt?: string | null;
  myJDownloaderSkippedAt?: string | null;
  skippedAt?: string | null;
  steamWishlistConfirmedAt?: string | null;
  steamWishlistSkippedAt?: string | null;
  updatedAt?: string | null;
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
  onlineFix?: OnlineFixSourceInfo | null;
  patchDownloadUrls: DownloadDescriptor[];
  notes?: string[];
  catalogMetadata?: {
    listedBuildId?: string | null;
    listedDate?: string | null;
    listedVersion?: string | null;
    method?: SourceMatchMethod | null;
  } | null;
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
  installedSourceKind?: SourceKind | null;
  installedSourceUrl?: string | null;
  updatedAt: string;
}

export type PlayniteExecutableConfidence = 'high' | 'medium' | 'low' | 'none';

export type PlayniteExecutableStatus =
  | 'auto_selected'
  | 'missing'
  | 'needs_review'
  | 'reviewed';

export interface PlayniteExecutableCandidate {
  excluded: boolean;
  fileName: string;
  fullPath: string;
  penalties: string[];
  reasons: string[];
  relativePath: string;
  score: number;
  sizeBytes: number;
}

export interface PlayniteExecutableSelectionRecord {
  candidates: PlayniteExecutableCandidate[];
  confidence: PlayniteExecutableConfidence;
  reviewedAt?: string | null;
  selectedExePath?: string | null;
  status: PlayniteExecutableStatus;
  steamAppId?: number | null;
  trackedItemId: string;
  updatedAt: string;
}

export type PlayniteLaunchMode = 'directExe' | 'duoSteamExe';

export interface PlayniteLaunchProfile {
  executablePath: string;
  launcherScriptPath?: string | null;
  mode: PlayniteLaunchMode;
  mirrorSteamActiveProcess?: boolean;
  steamAppId: number;
  waitForGameExit?: boolean;
  workingDirectory: string;
  writeSteamAppId?: boolean;
}

export interface PlayniteManifestGame {
  executablePath: string;
  executableRelativePath: string;
  installPath: string;
  launch?: PlayniteLaunchProfile;
  source: 'GameVault';
  steamAppId: number;
  steamStoreUrl: string;
  steamTitle?: string | null;
  title: string;
  trackedItemId: string;
  version?: string | null;
}

export interface PlayniteManifest {
  generatedAt: string;
  games: PlayniteManifestGame[];
  library: 'GameVault';
  version: 1;
}

export interface DuoStreamIntegrationStatus {
  current: boolean;
  enabled: boolean;
  eligibleGames: number;
  folderLauncherName: string;
  folderLaunchersWritten: number;
  lastError?: string | null;
  lastSyncedAt?: string | null;
  steamAppIdFilesWritten: number;
}

export interface PlayniteManifestStatus {
  current: boolean;
  exists: boolean;
  generatedAt?: string | null;
  manifestPath: string;
}

export interface PlayniteSyncStatus {
  current: boolean;
  exportableGames: number;
  importableGames: number;
  lastError?: string | null;
  lastSyncedAt?: string | null;
  manifestGeneratedAt?: string | null;
  pluginSeen: boolean;
  statusPath: string;
  syncedGames: number;
}

export interface PlayniteIntegrationStatus {
  bundledPluginVersion: string;
  duoStream: DuoStreamIntegrationStatus;
  enabled: boolean;
  exportableGames: number;
  installed: boolean;
  installedPluginVersion?: string | null;
  manifestStatus: PlayniteManifestStatus;
  manifestPath: string;
  pendingReviewCount: number;
  pendingReviews: Array<{
    gameTitle: string;
    selection: PlayniteExecutableSelectionRecord;
    steamAppId?: number | null;
    trackedItemId: string;
  }>;
  pluginInstallPath?: string | null;
  pluginInstalledAt?: string | null;
  pluginUpdateAvailable: boolean;
  pluginVersion?: string | null;
  playniteExtensionsPath?: string | null;
  syncStatus: PlayniteSyncStatus;
}

export interface SavePlayniteExecutableSelectionPayload {
  executablePath: string;
  trackedItemId: string;
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
  onlineFix?: OnlineFixSourceInfo | null;
  patchSelectionSource?: PatchSelectionSource | null;
  checkedAt: string;
}

export type SourceMatchStatus =
  | 'verified'
  | 'probable'
  | 'candidate'
  | 'not_found'
  | 'blocked'
  | 'failed';

export type SourceMatchMethod =
  | 'primary_source'
  | 'manual'
  | 'steam_app_id'
  | 'slug'
  | 'catalog_title'
  | 'recent_updates'
  | 'fuzzy_title';

export type SourceUpdateStatus =
  | 'unknown'
  | 'not_matched'
  | 'blocked'
  | 'failed'
  | 'same_as_installed'
  | 'newer_than_installed'
  | 'source_behind_upstream'
  | 'matches_upstream'
  | 'possible_update';

export interface SourceMatch {
  trackedItemId: string;
  sourceKind: SupportedSourceKind;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  normalizedTitle?: string | null;
  status: SourceMatchStatus;
  method: SourceMatchMethod;
  score: number;
  confidence: number;
  usable: boolean;
  isPrimary: boolean;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MatchedSourceView {
  match: SourceMatch;
  snapshot?: SourceSnapshot | null;
  matchedPatch?: SteamPatchEntry | null;
  versionsBehindLatest?: number | null;
  versionsBehindLatestIsLowerBound?: boolean;
  updateStatus: SourceUpdateStatus;
  isUpdateSource: boolean;
  downloadMirrors: DownloadMirrorRecord[];
  onlineFix?: OnlineFixSourceInfo | null;
}

export interface SourceCatalogEntry {
  sourceKind: SupportedSourceKind;
  sourceUrl: string;
  title: string;
  normalizedTitle: string;
  listedVersion?: string | null;
  listedBuildId?: string | null;
  listedDate?: string | null;
  steamAppId?: number | null;
  method: SourceMatchMethod;
}

export type PatchSelectionSource =
  | 'rss'
  | 'steamdb_builds'
  | 'manual'
  | 'older_than_available';
export type PatchMetadataStatus =
  | 'behind'
  | 'latest'
  | 'manual'
  | 'needs_attention'
  | 'outside_saved_history'
  | 'unknown';

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
  feedEtag?: string | null;
  feedLastModified?: string | null;
  patches: SteamPatchCandidate[];
}

export interface SteamFeedCheckRecord {
  trackedItemId: string;
  feedUrl?: string | null;
  feedEtag?: string | null;
  feedLastModified?: string | null;
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

export type DownloadProvider = 'direct_http' | 'jdownloader' | 'manual';

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
  sourceKind?: SupportedSourceKind | null;
  packageName: string;
  stagePath: string;
  finalPath: string;
  stage: DownloadStage;
  provider?: DownloadProvider | null;
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
  sourceKind?: SupportedSourceKind | null;
  url: string;
  label: string;
  kind: 'full' | 'patch';
  selectedAt?: string | null;
  manuallyFailedAt?: string | null;
  lastSeenAt: string;
}

export type ThemeMode = 'light' | 'dark';

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

export interface JDownloaderSourcePreferences {
  elamigos: boolean;
  steamrip: boolean;
}

export interface SettingsRecord {
  rootLibraryPath?: string | null;
  libraryRoots?: LibraryRootRecord[];
  renameGameFoldersOnImport?: boolean;
  ignoredImportFolders?: IgnoredImportFolderRecord[];
  jDownloaderEnabled?: boolean;
  jDownloaderSourcePreferences?: JDownloaderSourcePreferences;
  myJDownloaderEmail?: string | null;
  myJDownloaderDeviceId?: string | null;
  onboarding?: OnboardingState | null;
  lastExtensionActivityAt?: string | null;
  pollDailyHourLocal?: number;
  duoStreamCreateFolderLaunchers?: boolean;
  duoStreamCreateSteamAppIdFiles?: boolean;
  duoStreamIntegrationEnabled?: boolean;
  duoStreamUsePlayniteLauncher?: boolean;
  playniteExtensionsPath?: string | null;
  playniteIntegrationEnabled?: boolean;
  playniteManifestPath?: string | null;
  playnitePluginInstalledAt?: string | null;
  playnitePluginVersion?: string | null;
  sourceWatchDurationDays?: number;
  sourceWatchIntervalHours?: number;
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

export type ActivitySeverity = 'info' | 'warning' | 'error';

export type ActivityIssueKind =
  | 'download_failed'
  | 'download_stale'
  | 'recent_errors'
  | 'scheduler_stale'
  | 'source_error'
  | 'source_error_group'
  | 'source_watch_expired'
  | 'source_watch_overdue'
  | 'steamdb_error'
  | 'steamdb_error_group'
  | 'steamdb_rate_limited'
  | 'steamdb_stale';

export type MaintenanceJobKind =
  | 'download_poll'
  | 'source_watch'
  | 'steamdb_rss';

export type MaintenanceJobStatus =
  | 'cooldown'
  | 'failed'
  | 'queued'
  | 'running'
  | 'succeeded';

export type MaintenanceHeartbeatScope =
  | 'download'
  | 'scheduler'
  | 'source'
  | 'steamdb';

export interface MaintenanceJobRecord {
  id: string;
  kind: MaintenanceJobKind;
  status: MaintenanceJobStatus;
  trackedItemId?: string | null;
  sourceKind?: SupportedSourceKind | null;
  host?: string | null;
  gameTitle?: string | null;
  detail?: string | null;
  attemptCount: number;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  updatedAt: string;
}

export interface MaintenanceJobView extends MaintenanceJobRecord {
  retryInMs?: number | null;
}

export interface MaintenanceHeartbeat {
  completedAt?: string | null;
  detail?: string | null;
  error?: string | null;
  scope: MaintenanceHeartbeatScope;
  startedAt?: string | null;
  status: 'error' | 'ok' | 'running' | 'warning';
  updatedAt: string;
}

export type ActivityActionPayload =
  | {
      issueId: string;
      issueKey: string;
      trackedItemId?: string | null;
      type: 'dismissActivityIssue';
    }
  | { type: 'pauseSourceKind'; sourceKind: SupportedSourceKind; durationMs: number }
  | { type: 'pollDownloadJobs' }
  | { type: 'processSourceWatches' }
  | { type: 'retryTransientMaintenance' }
  | {
      type: 'refreshMatchedSource';
      trackedItemId: string;
      sourceKind: SupportedSourceKind;
    }
  | { type: 'refreshSteamFeeds' }
  | { type: 'refreshTrackedItem'; trackedItemId: string };

export interface ActivityIssueAction {
  label: string;
  payload?: ActivityActionPayload;
  target?: 'settings';
  disabledReason?: string | null;
}

export interface ActivityIssue {
  id: string;
  action?: ActivityIssueAction | null;
  createdAt?: string | null;
  detail: string;
  dismissalKey?: string;
  gameTitle?: string | null;
  kind: ActivityIssueKind;
  groupCount?: number | null;
  relatedGameTitles?: string[] | null;
  severity: ActivitySeverity;
  sourceKind?: SupportedSourceKind | null;
  title: string;
  trackedItemId?: string | null;
}

export type ActivitySummaryStatus = 'ok' | 'running' | 'warning' | 'error';

export interface ActivitySummaryCard {
  id:
    | 'automationErrors'
    | 'sourceMaintenance'
    | 'startupCatchUp'
    | 'steamDbMaintenance';
  detail: string;
  label: string;
  status: ActivitySummaryStatus;
  value: string;
}

export interface ActivityTask {
  id: string;
  detail?: string | null;
  progressCurrent?: number | null;
  progressTotal?: number | null;
  startedAt: string;
  status: 'running';
  title: string;
}

export interface ActivityView {
  activeTasks: ActivityTask[];
  generatedAt: string;
  heartbeats?: MaintenanceHeartbeat[];
  issues: ActivityIssue[];
  logs: EventLogRecord[];
  maintenanceJobs?: MaintenanceJobView[];
  summary: ActivitySummaryCard[];
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
  sourceMatches: MatchedSourceView[];
  installRecord?: InstallRecord | null;
  playniteExecutableSelection?: PlayniteExecutableSelectionRecord | null;
  currentWatch?: SourceWatch | null;
  latestPatch?: SteamPatchEntry | null;
  patchMetadataStatus?: PatchMetadataStatus;
  selectedPatch?: SteamPatchEntry | null;
  selectedPatchMissingFromFeed?: boolean;
  versionsBehindLatest?: number | null;
  versionsBehindLatestIsLowerBound?: boolean;
  currentDownload?: DownloadJobRecord | null;
  downloadMirrors: DownloadMirrorRecord[];
  onlineFix?: OnlineFixLibraryState;
  selectedMirror?: DownloadMirrorRecord | null;
  status: TrackedItemStatus;
  trackingStatus: TrackedItemTrackingStatus;
  activity: TrackedItemActivity;
  fileState: TrackedItemFileState;
}

export interface SelectedDownloads {
  fullUrl: string;
  patchUrl?: string | null;
  sourceKind?: SupportedSourceKind | null;
}

export interface AddTrackedItemRequestPayload {
  parsedSource: ParsedSourcePayload;
  steamMatch: ConfirmedSteamMatch | null;
  selectedSteamPatch: SteamPatchCandidate | null;
  steamPatchEntries?: SteamPatchCandidate[] | null;
  selectedDownloads: SelectedDownloads;
  queueDownload: boolean;
}

export interface CreateMatchedDraftPayload {
  deferMetadata?: boolean;
  parsedSource: ParsedSourcePayload;
  steamPatchEntries?: SteamPatchCandidate[] | null;
  steamMatch: ConfirmedSteamMatch;
}

export interface SyncTrackedSteamPatchEntriesPayload {
  appId: number;
  patches: SteamPatchCandidate[];
  trackedItemId: string;
}

export interface QueueDraftDownloadPayload {
  selectedDownloads: SelectedDownloads;
  selectedSteamPatch: SteamPatchCandidate;
  sourceKind: SupportedSourceKind;
  steamPatchEntries?: SteamPatchCandidate[] | null;
  trackedItemId: string;
}

export interface SteamMatchResolutionPayload {
  queryTitle: string;
  sourceKind: SourceKind;
  sourceUrl: string | null;
  candidates: SteamCandidate[];
  autoSelected: boolean;
  searchQueries?: string[];
}

export type SteamWishlistSource =
  | 'cache'
  | 'extension_session'
  | 'public_api';

export type SteamWishlistLibraryStatus =
  | 'installed'
  | 'not_in_library'
  | 'tracked';

export type SteamWishlistActionType = 'remove' | 'sync';
export type SteamWishlistActionStatus = 'complete' | 'failed' | 'pending';

export interface SteamWishlistMetadata {
  appId: number;
  coverUrl?: string | null;
  priceLabel?: string | null;
  releaseDate?: string | null;
  reviewSummary?: string | null;
  storeUrl: string;
  title: string;
}

export interface SteamWishlistSyncItem {
  appId: number;
  dateAdded?: string | null;
  priority?: number | null;
}

export interface SteamWishlistSyncPayload {
  fetchedAt?: string | null;
  items: SteamWishlistSyncItem[];
  profileUrl?: string | null;
  source?: SteamWishlistSource | null;
  steamId?: string | null;
}

export interface SteamWishlistCachedItem
  extends SteamWishlistMetadata,
    SteamWishlistSyncItem {
  lastSeenAt: string;
  normalizedTitle: string;
}

export interface SteamWishlistLibraryMatch {
  finalPath?: string | null;
  finalPathExists: boolean;
  status: SteamWishlistLibraryStatus;
  trackedItemId?: string | null;
  trackedStatus?: TrackedItemStatus | null;
  title?: string | null;
}

export interface SteamWishlistRemovalRecord {
  actionType: SteamWishlistActionType;
  appId?: number | null;
  completedAt?: string | null;
  errorMessage?: string | null;
  id: string;
  requestedAt: string;
  status: SteamWishlistActionStatus;
  title?: string | null;
  trackedItemId?: string | null;
}

export interface PendingSteamWishlistAction {
  actionType: SteamWishlistActionType;
  appId?: number | null;
  id: string;
  profileUrl?: string | null;
  requestedAt: string;
  steamId?: string | null;
  title?: string | null;
  trackedItemId?: string | null;
}

export interface CompleteSteamWishlistRemovalPayload {
  actionId: string;
  appId: number;
  errorMessage?: string | null;
  success: boolean;
}

export interface CompleteSteamWishlistSyncPayload {
  actionId: string;
  errorMessage?: string | null;
  success: boolean;
}

export interface SteamWishlistItemView extends SteamWishlistCachedItem {
  canRemoveFromSteamWishlist: boolean;
  library: SteamWishlistLibraryMatch;
  removalPending?: SteamWishlistRemovalRecord | null;
}

export interface SteamWishlistView {
  fetchedAt?: string | null;
  items: SteamWishlistItemView[];
  lastError?: string | null;
  pendingActions: PendingSteamWishlistAction[];
  profileUrl?: string | null;
  source: SteamWishlistSource;
  steamId?: string | null;
  totalCount: number;
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
  installedSourceKind?: SourceKind | null;
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
  snapshot: SourceSnapshot | null;
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
