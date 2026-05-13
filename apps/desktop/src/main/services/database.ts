import { ensureDir, readFileIfExists, writeBinaryFileSync } from './io.js';

import type {
  ConfirmedSteamMatch,
  DownloadJobPartRecord,
  DownloadJobRecord,
  DownloadMirrorRecord,
  EventLogRecord,
  IgnoredImportFolderRecord,
  InstallRecord,
  LibraryRootRecord,
  OnboardingState,
  ParsedSourcePayload,
  PlayniteExecutableCandidate,
  PlayniteExecutableConfidence,
  PlayniteExecutableSelectionRecord,
  PlayniteExecutableStatus,
  SettingsRecord,
  SourceMatch,
  SourceKind,
  SourceSnapshot,
  SupportedSourceKind,
  PendingSteamWishlistAction,
  SteamFeedCheckRecord,
  SourceWatch,
  SteamWishlistActionStatus,
  SteamWishlistActionType,
  SteamWishlistCachedItem,
  SteamWishlistRemovalRecord,
  SteamPatchEntry,
  SteamPatchCandidate,
  ThemeMode,
  TrackedItemRecord,
} from '@gamevault/shared-types';
import { mergePatchHistory } from '@gamevault/shared-types';
import initSqlJs, {
  type Database as SqlJsDatabase,
  type SqlJsStatic,
} from 'sql.js';
import { basename } from 'node:path';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tracked_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  source_kind TEXT,
  source_url TEXT UNIQUE,
  cover_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_snapshots (
  tracked_item_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  observed_version TEXT NOT NULL,
  observed_build_id TEXT,
  observed_patch_date TEXT,
  observed_patch_title TEXT,
  observed_patch_link TEXT,
  patch_selection_source TEXT,
  raw_payload_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (tracked_item_id, source_kind)
);

CREATE TABLE IF NOT EXISTS source_matches (
  tracked_item_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_url TEXT,
  source_title TEXT,
  normalized_title TEXT,
  status TEXT NOT NULL,
  method TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  usable INTEGER NOT NULL,
  is_primary INTEGER NOT NULL,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tracked_item_id, source_kind)
);

CREATE TABLE IF NOT EXISTS steam_matches (
  tracked_item_id TEXT PRIMARY KEY,
  app_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  cover_url TEXT,
  matched_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_steam_matches_app_id
ON steam_matches (app_id);

CREATE TABLE IF NOT EXISTS steam_patch_entries (
  id TEXT PRIMARY KEY,
  tracked_item_id TEXT NOT NULL,
  app_id INTEGER NOT NULL,
  patch_title TEXT NOT NULL,
  build_id TEXT,
  patch_date TEXT NOT NULL,
  published_at TEXT,
  link TEXT NOT NULL,
  version TEXT,
  description TEXT,
  selection_source TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patch_dedupe
ON steam_patch_entries (tracked_item_id, COALESCE(build_id, ''), patch_date, link);

CREATE TABLE IF NOT EXISTS steam_feed_checks (
  tracked_item_id TEXT PRIMARY KEY,
  feed_url TEXT,
  last_checked_at TEXT,
  last_successful_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steamdb_build_cache (
  app_id INTEGER PRIMARY KEY,
  patches_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steam_wishlist_items (
  app_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  cover_url TEXT,
  store_url TEXT NOT NULL,
  release_date TEXT,
  review_summary TEXT,
  price_label TEXT,
  priority INTEGER,
  date_added TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steam_wishlist_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  app_id INTEGER,
  tracked_item_id TEXT,
  title TEXT,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_steam_wishlist_actions_pending
ON steam_wishlist_actions (status, action_type, requested_at);

CREATE TABLE IF NOT EXISTS install_records (
  tracked_item_id TEXT PRIMARY KEY,
  installed_version TEXT,
  installed_build_id TEXT,
  installed_at TEXT,
  install_path TEXT,
  installed_source_kind TEXT,
  installed_source_url TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playnite_executable_selections (
  tracked_item_id TEXT PRIMARY KEY,
  steam_app_id INTEGER,
  selected_exe_path TEXT,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  reviewed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_watches (
  tracked_item_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL,
  last_checked_at TEXT,
  expired_at TEXT
);

CREATE TABLE IF NOT EXISTS download_jobs (
  id TEXT PRIMARY KEY,
  tracked_item_id TEXT NOT NULL,
  source_kind TEXT,
  package_name TEXT NOT NULL,
  stage_path TEXT NOT NULL,
  final_path TEXT NOT NULL,
  stage TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'jdownloader',
  package_id INTEGER,
  selected_mirror_url TEXT,
  selected_patch_mirror_url TEXT,
  bytes_loaded INTEGER,
  bytes_total INTEGER,
  speed INTEGER,
  eta_seconds INTEGER,
  status_message TEXT,
  completed_parts INTEGER,
  total_parts INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS download_job_parts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  tracked_item_id TEXT NOT NULL,
  role TEXT NOT NULL,
  package_name TEXT NOT NULL,
  mirror_url TEXT,
  stage TEXT NOT NULL,
  package_id INTEGER,
  bytes_loaded INTEGER,
  bytes_total INTEGER,
  speed INTEGER,
  eta_seconds INTEGER,
  status_message TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, role)
);

CREATE TABLE IF NOT EXISTS download_mirrors (
  tracked_item_id TEXT NOT NULL,
  source_kind TEXT,
  url TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  selected_at TEXT,
  manually_failed_at TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (tracked_item_id, source_kind, url, kind)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_issue_dismissals (
  issue_key TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  tracked_item_id TEXT,
  dismissed_at TEXT NOT NULL
);
`;

function randomId(): string {
  return crypto.randomUUID();
}

function normalizePublishedAt(value: string | null, patchDate: string): string {
  const parsed = new Date(value ?? patchDate);
  return Number.isNaN(parsed.getTime())
    ? new Date(0).toISOString()
    : parsed.toISOString();
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends object>(
  value: string | null | undefined,
): T | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}

function normalizeJDownloaderSourcePreferences(
  value: string | null | undefined,
): NonNullable<SettingsRecord['jDownloaderSourcePreferences']> {
  if (!value) {
    return {
      elamigos: true,
      steamrip: true,
    };
  }

  try {
    const parsed = JSON.parse(value) as Partial<
      NonNullable<SettingsRecord['jDownloaderSourcePreferences']>
    >;
    return {
      elamigos: parsed.elamigos !== false,
      steamrip: parsed.steamrip !== false,
    };
  } catch {
    return {
      elamigos: true,
      steamrip: true,
    };
  }
}

function normalizeThemeMode(
  value: string | null | undefined,
): Extract<ThemeMode, 'dark' | 'light'> {
  return value === 'light' ? 'light' : 'dark';
}

function normalizePlayniteExecutableConfidence(
  value: string | null | undefined,
): PlayniteExecutableConfidence {
  return value === 'high' ||
    value === 'medium' ||
    value === 'low' ||
    value === 'none'
    ? value
    : 'none';
}

function normalizePlayniteExecutableStatus(
  value: string | null | undefined,
): PlayniteExecutableStatus {
  return value === 'auto_selected' ||
    value === 'missing' ||
    value === 'needs_review' ||
    value === 'reviewed'
    ? value
    : 'needs_review';
}

function normalizePlayniteExecutableCandidates(
  value: string | null | undefined,
): PlayniteExecutableCandidate[] {
  return parseJsonArray<Partial<PlayniteExecutableCandidate>>(value)
    .filter(
      (entry) =>
        typeof entry.fullPath === 'string' &&
        typeof entry.relativePath === 'string' &&
        typeof entry.fileName === 'string',
    )
    .map((entry) => ({
      excluded: Boolean(entry.excluded),
      fileName: entry.fileName!,
      fullPath: entry.fullPath!,
      penalties: Array.isArray(entry.penalties)
        ? entry.penalties.filter((reason): reason is string => typeof reason === 'string')
        : [],
      reasons: Array.isArray(entry.reasons)
        ? entry.reasons.filter((reason): reason is string => typeof reason === 'string')
        : [],
      relativePath: entry.relativePath!,
      score: typeof entry.score === 'number' ? entry.score : 0,
      sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0,
    }));
}

function getDefaultJDownloaderEnabled(map: Map<string, string | null>): boolean {
  if (map.has('download.jdownloader.enabled')) {
    return map.get('download.jdownloader.enabled') === 'true';
  }

  return Boolean(map.get('myjd.email')?.trim() && map.get('myjd.password'));
}

function normalizeLibraryRootRecord(
  value: Partial<LibraryRootRecord>,
  index: number,
): LibraryRootRecord | null {
  const path = typeof value.path === 'string' ? value.path.trim() : '';
  if (!path) {
    return null;
  }

  const label =
    typeof value.label === 'string' && value.label.trim()
      ? value.label.trim()
      : basename(path) || path;

  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : `library-root-${index}`,
    isPrimary: Boolean(value.isPrimary),
    label,
    path,
  };
}

function normalizeLibraryRoots(
  storedRoots: LibraryRootRecord[],
  legacyRootPath: string | null,
): LibraryRootRecord[] {
  const normalized = storedRoots
    .map((root, index) => normalizeLibraryRootRecord(root, index))
    .filter((root): root is LibraryRootRecord => root != null);

  if (normalized.length === 0 && legacyRootPath?.trim()) {
    normalized.push({
      id: 'library-root-primary',
      isPrimary: true,
      label: basename(legacyRootPath) || legacyRootPath,
      path: legacyRootPath,
    });
  }

  if (normalized.length > 0 && !normalized.some((root) => root.isPrimary)) {
    normalized[0] = { ...normalized[0]!, isPrimary: true };
  }

  const primarySeen = { value: false };
  return normalized.map((root) => {
    if (!root.isPrimary) {
      return root;
    }

    if (primarySeen.value) {
      return { ...root, isPrimary: false };
    }

    primarySeen.value = true;
    return root;
  });
}

function applyMigrations(db: SqlJsDatabase): void {
  const statements = [
    `ALTER TABLE download_jobs ADD COLUMN provider TEXT`,
    `ALTER TABLE download_jobs ADD COLUMN selected_mirror_url TEXT`,
    `ALTER TABLE download_jobs ADD COLUMN selected_patch_mirror_url TEXT`,
    `ALTER TABLE download_jobs ADD COLUMN bytes_loaded INTEGER`,
    `ALTER TABLE download_jobs ADD COLUMN bytes_total INTEGER`,
    `ALTER TABLE download_jobs ADD COLUMN speed INTEGER`,
    `ALTER TABLE download_jobs ADD COLUMN eta_seconds INTEGER`,
    `ALTER TABLE download_jobs ADD COLUMN status_message TEXT`,
    `ALTER TABLE download_jobs ADD COLUMN completed_parts INTEGER`,
    `ALTER TABLE download_jobs ADD COLUMN total_parts INTEGER`,
    `ALTER TABLE source_snapshots ADD COLUMN observed_patch_title TEXT`,
    `ALTER TABLE source_snapshots ADD COLUMN observed_patch_link TEXT`,
    `ALTER TABLE source_snapshots ADD COLUMN patch_selection_source TEXT`,
    `ALTER TABLE steam_patch_entries ADD COLUMN published_at TEXT`,
    `ALTER TABLE steam_patch_entries ADD COLUMN version TEXT`,
    `ALTER TABLE steam_patch_entries ADD COLUMN description TEXT`,
    `ALTER TABLE steam_patch_entries ADD COLUMN selection_source TEXT`,
    `ALTER TABLE steam_feed_checks ADD COLUMN feed_url TEXT`,
    `ALTER TABLE install_records ADD COLUMN install_path TEXT`,
    `ALTER TABLE install_records ADD COLUMN installed_source_kind TEXT`,
    `ALTER TABLE install_records ADD COLUMN installed_source_url TEXT`,
    `ALTER TABLE download_jobs ADD COLUMN source_kind TEXT`,
  ];

  for (const statement of statements) {
    try {
      db.exec(statement);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/duplicate column name/i.test(error.message)
      ) {
        throw error;
      }
    }
  }

  migrateSourceSnapshotsPrimaryKey(db);
  migrateSourceMatches(db);
  migrateDownloadMirrorsPrimaryKey(db);
  migrateDownloadJobParts(db);
  repairTransientSourceMatchState(db);
  repairSourceSnapshotsFromRawPayload(db);
  repairDownloadJobProviderAndSourceKind(db);
}

function repairDownloadJobProviderAndSourceKind(db: SqlJsDatabase): void {
  db.exec(`
    UPDATE download_jobs
       SET provider = 'direct_http'
     WHERE provider = 'embedded_browser';

    UPDATE download_jobs
       SET source_kind = (
             SELECT source_kind
               FROM tracked_items
              WHERE tracked_items.id = download_jobs.tracked_item_id
           )
     WHERE source_kind IS NULL
        OR source_kind = '';
  `);
}

function repairTransientSourceMatchState(db: SqlJsDatabase): void {
  db.exec(`
    UPDATE source_matches
       SET status = CASE
             WHEN EXISTS (
               SELECT 1
                 FROM source_snapshots
                WHERE source_snapshots.tracked_item_id = source_matches.tracked_item_id
                  AND source_snapshots.source_kind = source_matches.source_kind
                  AND rtrim(source_snapshots.source_url, '/') = rtrim(source_matches.source_url, '/')
             )
             THEN 'probable'
             ELSE 'candidate'
           END,
           usable = CASE
             WHEN EXISTS (
               SELECT 1
                 FROM source_snapshots
                WHERE source_snapshots.tracked_item_id = source_matches.tracked_item_id
                  AND source_snapshots.source_kind = source_matches.source_kind
                  AND rtrim(source_snapshots.source_url, '/') = rtrim(source_matches.source_url, '/')
             )
             THEN 1
             ELSE 0
           END,
           last_error = CASE
             WHEN COALESCE(last_error, '') LIKE '%429%'
             THEN 'Rate limited by source; retrying later.'
             ELSE last_error
           END
     WHERE source_kind = 'ankergames'
       AND status = 'blocked'
       AND source_url IS NOT NULL
       AND source_url != ''
       AND COALESCE(last_error, '') LIKE '%429%';

    UPDATE source_matches
       SET status = 'probable',
           usable = 1
     WHERE source_kind = 'ankergames'
       AND status = 'candidate'
       AND usable = 0
       AND source_url IS NOT NULL
       AND source_url != ''
       AND EXISTS (
             SELECT 1
               FROM source_snapshots
              WHERE source_snapshots.tracked_item_id = source_matches.tracked_item_id
                AND source_snapshots.source_kind = source_matches.source_kind
                AND rtrim(source_snapshots.source_url, '/') = rtrim(source_matches.source_url, '/')
           );

    DELETE FROM source_matches
     WHERE source_kind = 'elamigos'
       AND status = 'not_found'
       AND method = 'fuzzy_title'
       AND score = 0
       AND source_url IS NULL
       AND is_primary = 0;
  `);
}

function optionalTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function repairSourceSnapshotsFromRawPayload(db: SqlJsDatabase): void {
  const rows: Array<{
    tracked_item_id: string;
    source_kind: SourceKind;
    source_url: string;
    fingerprint: string;
    observed_version: string;
    observed_build_id: string | null;
    observed_patch_date: string | null;
    patch_selection_source: string | null;
    raw_payload_json: string;
  }> = [];
  const statement = db.prepare(`
    SELECT tracked_item_id, source_kind, source_url, fingerprint,
           observed_version, observed_build_id, observed_patch_date,
           patch_selection_source, raw_payload_json
      FROM source_snapshots
     WHERE source_kind != 'manual'
       AND raw_payload_json IS NOT NULL
       AND raw_payload_json != 'null'
  `);
  while (statement.step()) {
    rows.push(statement.getAsObject() as (typeof rows)[number]);
  }
  statement.free();

  for (const row of rows) {
    let payload: Partial<ParsedSourcePayload> | null = null;
    try {
      payload = JSON.parse(
        row.raw_payload_json,
      ) as Partial<ParsedSourcePayload>;
    } catch {
      payload = null;
    }

    if (
      !payload?.latestSourceRelease ||
      payload.sourceKind !== row.source_kind
    ) {
      continue;
    }

    const release = payload.latestSourceRelease;
    const observedVersion =
      optionalTrimmedString(release.version) ?? row.observed_version;
    const observedBuildId = optionalTrimmedString(release.buildId);
    const observedPatchDate = optionalTrimmedString(release.patchDate);
    const sourceUrl =
      optionalTrimmedString(payload.sourceUrl) ?? row.source_url;
    const fingerprint =
      optionalTrimmedString(payload.fingerprint) ?? row.fingerprint;
    const shouldRepair =
      row.patch_selection_source != null ||
      row.observed_version !== observedVersion ||
      row.observed_build_id !== observedBuildId ||
      row.observed_patch_date !== observedPatchDate ||
      row.source_url !== sourceUrl ||
      row.fingerprint !== fingerprint;

    if (!shouldRepair) {
      continue;
    }

    db.run(
      `UPDATE source_snapshots
          SET source_url = ?,
              fingerprint = ?,
              observed_version = ?,
              observed_build_id = ?,
              observed_patch_date = ?,
              observed_patch_title = NULL,
              observed_patch_link = NULL,
              patch_selection_source = NULL
        WHERE tracked_item_id = ? AND source_kind = ?`,
      [
        sourceUrl,
        fingerprint,
        observedVersion,
        observedBuildId,
        observedPatchDate,
        row.tracked_item_id,
        row.source_kind,
      ],
    );
  }
}

function tableHasColumn(
  db: SqlJsDatabase,
  tableName: string,
  columnName: string,
): boolean {
  const tableInfo = db.exec(`PRAGMA table_info(${tableName})`);
  const rows = tableInfo[0]?.values ?? [];
  return rows.some((row) => String(row[1]) === columnName);
}

function getPrimaryKeyColumns(db: SqlJsDatabase, tableName: string): string[] {
  const tableInfo = db.exec(`PRAGMA table_info(${tableName})`);
  const rows = tableInfo[0]?.values ?? [];
  return rows
    .filter((row) => Number(row[5]) > 0)
    .sort((left, right) => Number(left[5]) - Number(right[5]))
    .map((row) => String(row[1]));
}

function migrateSourceSnapshotsPrimaryKey(db: SqlJsDatabase): void {
  const primaryKeyColumns = getPrimaryKeyColumns(db, 'source_snapshots');
  if (primaryKeyColumns.join('|') === 'tracked_item_id|source_kind') {
    return;
  }

  db.exec(`
    DROP TABLE IF EXISTS source_snapshots_next;
    CREATE TABLE source_snapshots_next (
      tracked_item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_url TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      observed_version TEXT NOT NULL,
      observed_build_id TEXT,
      observed_patch_date TEXT,
      observed_patch_title TEXT,
      observed_patch_link TEXT,
      patch_selection_source TEXT,
      raw_payload_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (tracked_item_id, source_kind)
    );
    INSERT OR REPLACE INTO source_snapshots_next (
      tracked_item_id, source_kind, source_url, fingerprint, observed_version,
      observed_build_id, observed_patch_date, observed_patch_title,
      observed_patch_link, patch_selection_source, raw_payload_json, checked_at
    )
    SELECT
      tracked_item_id, source_kind, source_url, fingerprint, observed_version,
      observed_build_id, observed_patch_date, observed_patch_title,
      observed_patch_link, patch_selection_source, raw_payload_json, checked_at
    FROM source_snapshots;
    DROP TABLE source_snapshots;
    ALTER TABLE source_snapshots_next RENAME TO source_snapshots;
  `);
}

function migrateSourceMatches(db: SqlJsDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_matches (
      tracked_item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_url TEXT,
      source_title TEXT,
      normalized_title TEXT,
      status TEXT NOT NULL,
      method TEXT NOT NULL,
      score REAL NOT NULL,
      confidence REAL NOT NULL,
      usable INTEGER NOT NULL,
      is_primary INTEGER NOT NULL,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tracked_item_id, source_kind)
    );

    INSERT OR IGNORE INTO source_matches (
      tracked_item_id, source_kind, source_url, source_title, normalized_title,
      status, method, score, confidence, usable, is_primary, last_checked_at,
      last_error, created_at, updated_at
    )
    SELECT
      id,
      source_kind,
      source_url,
      title,
      normalized_title,
      'verified',
      'primary_source',
      1,
      1,
      CASE WHEN source_kind = 'manual' THEN 0 ELSE 1 END,
      1,
      NULL,
      NULL,
      created_at,
      updated_at
    FROM tracked_items
    WHERE source_kind IN ('ankergames', 'elamigos', 'steamrip')
      AND source_url IS NOT NULL
      AND source_url != '';
  `);
}

function migrateDownloadJobParts(db: SqlJsDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS download_job_parts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      tracked_item_id TEXT NOT NULL,
      role TEXT NOT NULL,
      package_name TEXT NOT NULL,
      mirror_url TEXT,
      stage TEXT NOT NULL,
      package_id INTEGER,
      bytes_loaded INTEGER,
      bytes_total INTEGER,
      speed INTEGER,
      eta_seconds INTEGER,
      status_message TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, role)
    );

    INSERT OR IGNORE INTO download_job_parts (
      id, job_id, tracked_item_id, role, package_name, mirror_url, stage,
      package_id, bytes_loaded, bytes_total, speed, eta_seconds, status_message,
      error_message, created_at, updated_at
    )
    SELECT
      id || ':full',
      id,
      tracked_item_id,
      'full',
      package_name,
      selected_mirror_url,
      stage,
      package_id,
      bytes_loaded,
      bytes_total,
      speed,
      eta_seconds,
      status_message,
      error_message,
      created_at,
      updated_at
    FROM download_jobs;

    INSERT OR IGNORE INTO download_job_parts (
      id, job_id, tracked_item_id, role, package_name, mirror_url, stage,
      package_id, bytes_loaded, bytes_total, speed, eta_seconds, status_message,
      error_message, created_at, updated_at
    )
    SELECT
      id || ':patch',
      id,
      tracked_item_id,
      'patch',
      CASE
        WHEN package_name LIKE '%\\_full' ESCAPE '\\'
          THEN substr(package_name, 1, length(package_name) - 5) || '_update'
        ELSE package_name || '_update'
      END,
      selected_patch_mirror_url,
      stage,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      status_message,
      error_message,
      created_at,
      updated_at
    FROM download_jobs
    WHERE selected_patch_mirror_url IS NOT NULL
      AND selected_patch_mirror_url != '';
  `);
}

function migrateDownloadMirrorsPrimaryKey(db: SqlJsDatabase): void {
  const primaryKeyColumns = getPrimaryKeyColumns(db, 'download_mirrors');
  if (primaryKeyColumns.join('|') === 'tracked_item_id|source_kind|url|kind') {
    return;
  }

  const hasSourceKindColumn = tableHasColumn(
    db,
    'download_mirrors',
    'source_kind',
  );
  const sourceKindExpression = hasSourceKindColumn
    ? 'source_kind'
    : `(SELECT source_kind FROM tracked_items WHERE tracked_items.id = download_mirrors.tracked_item_id)`;

  db.exec(`
    DROP TABLE IF EXISTS download_mirrors_next;
    CREATE TABLE download_mirrors_next (
      tracked_item_id TEXT NOT NULL,
      source_kind TEXT,
      url TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      selected_at TEXT,
      manually_failed_at TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (tracked_item_id, source_kind, url, kind)
    );
    INSERT OR REPLACE INTO download_mirrors_next (
      tracked_item_id, source_kind, url, label, kind, selected_at, manually_failed_at, last_seen_at
    )
    SELECT tracked_item_id, ${sourceKindExpression}, url, label, kind, selected_at, manually_failed_at, last_seen_at
    FROM download_mirrors;
    DROP TABLE download_mirrors;
    ALTER TABLE download_mirrors_next RENAME TO download_mirrors;
  `);
}

type SqlScalar = string | number | null;

interface SteamDbBuildCacheRecord {
  appId: number;
  capturedAt: string;
  expiresAt: string;
  patches: SteamPatchCandidate[];
}

export class GameVaultDatabase {
  private constructor(
    private readonly db: SqlJsDatabase,
    private readonly filePath: string,
  ) {}

  static async open(
    filePath: string,
    wasmPath: string,
  ): Promise<GameVaultDatabase> {
    const SQL = (await initSqlJs({
      locateFile: () => wasmPath,
    })) as SqlJsStatic;
    await ensureDir(filePath);
    const persisted = await readFileIfExists(filePath);
    const db = persisted ? new SQL.Database(persisted) : new SQL.Database();
    db.exec(SCHEMA_SQL);
    applyMigrations(db);
    writeBinaryFileSync(filePath, db.export());
    return new GameVaultDatabase(db, filePath);
  }

  static async countTrackedItems(
    filePath: string,
    wasmPath: string,
  ): Promise<number | null> {
    const persisted = await readFileIfExists(filePath);
    if (!persisted) {
      return null;
    }

    const SQL = (await initSqlJs({
      locateFile: () => wasmPath,
    })) as SqlJsStatic;
    const db = new SQL.Database(persisted);
    try {
      const tableResult = db.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracked_items'",
      );
      if (!tableResult[0]?.values.length) {
        return 0;
      }

      const countResult = db.exec('SELECT COUNT(*) FROM tracked_items');
      return Number(countResult[0]?.values[0]?.[0] ?? 0);
    } finally {
      db.close();
    }
  }

  private save(): void {
    const binary = this.db.export();
    writeBinaryFileSync(this.filePath, binary);
  }

  private exec(sql: string, params: SqlScalar[] = []): void {
    this.db.run(sql, params);
    this.save();
  }

  private queryAll<T>(sql: string, params: SqlScalar[] = []): T[] {
    const statement = this.db.prepare(sql, params);
    const rows: T[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }
    statement.free();
    return rows;
  }

  private queryOne<T>(sql: string, params: SqlScalar[] = []): T | null {
    return this.queryAll<T>(sql, params)[0] ?? null;
  }

  listTrackedItems(): TrackedItemRecord[] {
    return this.queryAll<{
      id: string;
      title: string;
      normalized_title: string;
      source_kind: SourceKind | null;
      source_url: string | null;
      cover_url: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, title, normalized_title, source_kind, source_url, cover_url, created_at, updated_at
       FROM tracked_items
       ORDER BY updated_at DESC`,
    ).map((row) => ({
      coverUrl: row.cover_url,
      createdAt: row.created_at,
      id: row.id,
      normalizedTitle: row.normalized_title,
      sourceKind: row.source_kind,
      sourceUrl: row.source_url,
      title: row.title,
      updatedAt: row.updated_at,
    }));
  }

  findTrackedItemById(id: string): TrackedItemRecord | null {
    return this.listTrackedItems().find((entry) => entry.id === id) ?? null;
  }

  findTrackedItemBySourceUrl(sourceUrl: string): TrackedItemRecord | null {
    return (
      this.listTrackedItems().find((entry) => entry.sourceUrl === sourceUrl) ??
      null
    );
  }

  findManualTrackedItemByNormalizedTitle(
    normalizedTitle: string,
  ): TrackedItemRecord | null {
    return (
      this.listTrackedItems().find(
        (entry) =>
          entry.sourceKind === 'manual' &&
          entry.normalizedTitle === normalizedTitle,
      ) ?? null
    );
  }

  upsertTrackedItem(record: {
    coverUrl?: string | null;
    id?: string;
    normalizedTitle: string;
    sourceKind?: SourceKind | null;
    sourceUrl?: string | null;
    title: string;
  }): TrackedItemRecord {
    const now = new Date().toISOString();
    const existing = record.sourceUrl
      ? this.findTrackedItemBySourceUrl(record.sourceUrl)
      : record.sourceKind === 'manual'
        ? this.findManualTrackedItemByNormalizedTitle(record.normalizedTitle)
        : null;
    const id = existing?.id ?? record.id ?? randomId();

    this.exec(
      `INSERT INTO tracked_items (
         id, title, normalized_title, source_kind, source_url, cover_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         normalized_title = excluded.normalized_title,
         source_kind = excluded.source_kind,
         source_url = excluded.source_url,
         cover_url = COALESCE(excluded.cover_url, tracked_items.cover_url),
         updated_at = excluded.updated_at`,
      [
        id,
        record.title,
        record.normalizedTitle,
        record.sourceKind ?? null,
        record.sourceUrl ?? null,
        record.coverUrl ?? null,
        existing?.createdAt ?? now,
        now,
      ],
    );

    return this.findTrackedItemById(id)!;
  }

  updateTrackedItemPrimarySource(
    trackedItemId: string,
    record: {
      coverUrl?: string | null;
      normalizedTitle: string;
      sourceKind: SourceKind;
      sourceUrl: string;
      title: string;
    },
  ): TrackedItemRecord {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE tracked_items
       SET title = ?,
           normalized_title = ?,
           source_kind = ?,
           source_url = ?,
           cover_url = COALESCE(?, cover_url),
           updated_at = ?
       WHERE id = ?`,
      [
        record.title,
        record.normalizedTitle,
        record.sourceKind,
        record.sourceUrl,
        record.coverUrl ?? null,
        now,
        trackedItemId,
      ],
    );

    const item = this.findTrackedItemById(trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${trackedItemId} not found`);
    }
    return item;
  }

  listSourceMatches(trackedItemId: string): SourceMatch[] {
    return this.queryAll<{
      confidence: number;
      created_at: string;
      is_primary: number;
      last_checked_at: string | null;
      last_error: string | null;
      method: SourceMatch['method'];
      normalized_title: string | null;
      score: number;
      source_kind: SupportedSourceKind;
      source_title: string | null;
      source_url: string | null;
      status: SourceMatch['status'];
      tracked_item_id: string;
      updated_at: string;
      usable: number;
    }>(
      `SELECT * FROM source_matches
       WHERE tracked_item_id = ?
       ORDER BY is_primary DESC, source_kind ASC`,
      [trackedItemId],
    ).map((row) => ({
      confidence: row.confidence,
      createdAt: row.created_at,
      isPrimary: Boolean(row.is_primary),
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error,
      method: row.method,
      normalizedTitle: row.normalized_title,
      score: row.score,
      sourceKind: row.source_kind,
      sourceTitle: row.source_title,
      sourceUrl: row.source_url,
      status: row.status,
      trackedItemId: row.tracked_item_id,
      updatedAt: row.updated_at,
      usable: Boolean(row.usable),
    }));
  }

  getSourceMatch(
    trackedItemId: string,
    sourceKind: SupportedSourceKind,
  ): SourceMatch | null {
    return (
      this.listSourceMatches(trackedItemId).find(
        (match) => match.sourceKind === sourceKind,
      ) ?? null
    );
  }

  upsertSourceMatch(match: SourceMatch): void {
    const existing = this.getSourceMatch(match.trackedItemId, match.sourceKind);
    this.exec(
      `INSERT INTO source_matches (
         tracked_item_id, source_kind, source_url, source_title, normalized_title,
         status, method, score, confidence, usable, is_primary, last_checked_at,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id, source_kind) DO UPDATE SET
         source_url = excluded.source_url,
         source_title = excluded.source_title,
         normalized_title = excluded.normalized_title,
         status = excluded.status,
         method = excluded.method,
         score = excluded.score,
         confidence = excluded.confidence,
         usable = excluded.usable,
         is_primary = excluded.is_primary,
         last_checked_at = excluded.last_checked_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        match.trackedItemId,
        match.sourceKind,
        match.sourceUrl ?? null,
        match.sourceTitle ?? null,
        match.normalizedTitle ?? null,
        match.status,
        match.method,
        match.score,
        match.confidence,
        match.usable ? 1 : 0,
        match.isPrimary ? 1 : 0,
        match.lastCheckedAt ?? null,
        match.lastError ?? null,
        existing?.createdAt ?? match.createdAt,
        match.updatedAt,
      ],
    );
  }

  listSourceSnapshots(trackedItemId: string): SourceSnapshot[] {
    return this.queryAll<{
      checked_at: string;
      fingerprint: string;
      observed_build_id: string | null;
      observed_patch_date: string | null;
      observed_patch_link: string | null;
      observed_patch_title: string | null;
      observed_version: string;
      patch_selection_source: SourceSnapshot['patchSelectionSource'] | null;
      source_kind: SourceKind;
      source_url: string;
      tracked_item_id: string;
    }>(`SELECT * FROM source_snapshots WHERE tracked_item_id = ?`, [
      trackedItemId,
    ]).map((row) => ({
      checkedAt: row.checked_at,
      fingerprint: row.fingerprint,
      observedBuildId: row.observed_build_id,
      observedPatchDate: row.observed_patch_date,
      observedPatchLink: row.observed_patch_link,
      observedPatchTitle: row.observed_patch_title,
      patchSelectionSource: row.patch_selection_source,
      observedVersion: row.observed_version,
      sourceKind: row.source_kind,
      sourceUrl: row.source_url,
      trackedItemId: row.tracked_item_id,
    }));
  }

  getSourceSnapshot(
    trackedItemId: string,
    sourceKind?: SourceKind | null,
  ): SourceSnapshot | null {
    const row = this.queryOne<{
      tracked_item_id: string;
      source_kind: SourceKind;
      source_url: string;
      fingerprint: string;
      observed_version: string;
      observed_build_id: string | null;
      observed_patch_date: string | null;
      observed_patch_link: string | null;
      observed_patch_title: string | null;
      patch_selection_source: SourceSnapshot['patchSelectionSource'] | null;
      raw_payload_json: string;
      checked_at: string;
    }>(
      sourceKind
        ? `SELECT * FROM source_snapshots WHERE tracked_item_id = ? AND source_kind = ?`
        : `SELECT source_snapshots.*
           FROM source_snapshots
           LEFT JOIN source_matches
             ON source_matches.tracked_item_id = source_snapshots.tracked_item_id
            AND source_matches.source_kind = source_snapshots.source_kind
           WHERE source_snapshots.tracked_item_id = ?
           ORDER BY source_matches.is_primary DESC, source_snapshots.checked_at DESC
           LIMIT 1`,
      sourceKind ? [trackedItemId, sourceKind] : [trackedItemId],
    );

    if (!row) {
      return null;
    }

    return {
      checkedAt: row.checked_at,
      fingerprint: row.fingerprint,
      observedBuildId: row.observed_build_id,
      observedPatchDate: row.observed_patch_date,
      observedPatchLink: row.observed_patch_link,
      observedPatchTitle: row.observed_patch_title,
      patchSelectionSource: row.patch_selection_source,
      observedVersion: row.observed_version,
      sourceKind: row.source_kind,
      sourceUrl: row.source_url,
      trackedItemId: row.tracked_item_id,
    };
  }

  upsertSourceSnapshot(snapshot: SourceSnapshot): void {
    const rawPayloadJson = this.queryOne<{ raw_payload_json: string }>(
      `SELECT raw_payload_json FROM source_snapshots
       WHERE tracked_item_id = ? AND source_kind = ?`,
      [snapshot.trackedItemId, snapshot.sourceKind],
    )?.raw_payload_json;
    this.exec(
      `INSERT INTO source_snapshots (
         tracked_item_id, source_kind, source_url, fingerprint, observed_version, observed_build_id,
         observed_patch_date, observed_patch_title, observed_patch_link, patch_selection_source,
         raw_payload_json, checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id, source_kind) DO UPDATE SET
         source_kind = excluded.source_kind,
         source_url = excluded.source_url,
         fingerprint = excluded.fingerprint,
         observed_version = excluded.observed_version,
         observed_build_id = excluded.observed_build_id,
         observed_patch_date = excluded.observed_patch_date,
         observed_patch_title = excluded.observed_patch_title,
         observed_patch_link = excluded.observed_patch_link,
         patch_selection_source = excluded.patch_selection_source,
         raw_payload_json = excluded.raw_payload_json,
         checked_at = excluded.checked_at`,
      [
        snapshot.trackedItemId,
        snapshot.sourceKind,
        snapshot.sourceUrl,
        snapshot.fingerprint,
        snapshot.observedVersion,
        snapshot.observedBuildId ?? null,
        snapshot.observedPatchDate ?? null,
        snapshot.observedPatchTitle ?? null,
        snapshot.observedPatchLink ?? null,
        snapshot.patchSelectionSource ?? null,
        rawPayloadJson ?? JSON.stringify(null),
        snapshot.checkedAt,
      ],
    );
  }

  setRawParsedSourcePayload(
    trackedItemId: string,
    payload: ParsedSourcePayload,
  ): void {
    this.exec(
      `UPDATE source_snapshots
       SET raw_payload_json = ?
       WHERE tracked_item_id = ? AND source_kind = ?`,
      [JSON.stringify(payload), trackedItemId, payload.sourceKind],
    );
  }

  getRawParsedSourcePayload(
    trackedItemId: string,
    sourceKind?: SupportedSourceKind | null,
  ): ParsedSourcePayload | null {
    const row = this.queryOne<{ raw_payload_json: string }>(
      sourceKind
        ? `SELECT raw_payload_json FROM source_snapshots
           WHERE tracked_item_id = ? AND source_kind = ?`
        : `SELECT source_snapshots.raw_payload_json
           FROM source_snapshots
           LEFT JOIN source_matches
             ON source_matches.tracked_item_id = source_snapshots.tracked_item_id
            AND source_matches.source_kind = source_snapshots.source_kind
           WHERE source_snapshots.tracked_item_id = ?
           ORDER BY source_matches.is_primary DESC, source_snapshots.checked_at DESC
           LIMIT 1`,
      sourceKind ? [trackedItemId, sourceKind] : [trackedItemId],
    );
    if (!row?.raw_payload_json || row.raw_payload_json === 'null') {
      return null;
    }

    return JSON.parse(row.raw_payload_json) as ParsedSourcePayload;
  }

  listDownloadMirrors(
    trackedItemId: string,
    sourceKind?: SupportedSourceKind | null,
  ): DownloadMirrorRecord[] {
    return this.queryAll<{
      tracked_item_id: string;
      source_kind: SupportedSourceKind | null;
      url: string;
      label: string;
      kind: 'full' | 'patch';
      selected_at: string | null;
      manually_failed_at: string | null;
      last_seen_at: string;
    }>(
      sourceKind
        ? `SELECT * FROM download_mirrors
           WHERE tracked_item_id = ? AND source_kind = ?
           ORDER BY selected_at DESC, label ASC`
        : `SELECT * FROM download_mirrors
           WHERE tracked_item_id = ?
           ORDER BY selected_at DESC, label ASC`,
      sourceKind ? [trackedItemId, sourceKind] : [trackedItemId],
    ).map((row) => ({
      kind: row.kind,
      label: row.label,
      lastSeenAt: row.last_seen_at,
      manuallyFailedAt: row.manually_failed_at,
      selectedAt: row.selected_at,
      sourceKind: row.source_kind,
      trackedItemId: row.tracked_item_id,
      url: row.url,
    }));
  }

  syncDownloadMirrors(
    trackedItemId: string,
    sourceKind: SupportedSourceKind,
    mirrors: Array<{
      url: string;
      label: string;
      kind: 'full' | 'patch';
    }>,
  ): void {
    const now = new Date().toISOString();
    for (const mirror of mirrors) {
      this.exec(
        `INSERT INTO download_mirrors (
         tracked_item_id, source_kind, url, label, kind, selected_at, manually_failed_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(tracked_item_id, source_kind, url, kind) DO UPDATE SET
           label = excluded.label,
           last_seen_at = excluded.last_seen_at`,
        [trackedItemId, sourceKind, mirror.url, mirror.label, mirror.kind, now],
      );
    }
  }

  deleteDownloadMirrorsByKindExceptUrls(params: {
    kind: 'full' | 'patch';
    sourceKind: SupportedSourceKind;
    trackedItemId: string;
    urls: string[];
  }): void {
    if (params.urls.length === 0) {
      this.exec(
        `DELETE FROM download_mirrors
         WHERE tracked_item_id = ? AND source_kind = ? AND kind = ?`,
        [params.trackedItemId, params.sourceKind, params.kind],
      );
      return;
    }

    const placeholders = params.urls.map(() => '?').join(', ');
    this.exec(
      `DELETE FROM download_mirrors
       WHERE tracked_item_id = ? AND source_kind = ? AND kind = ?
         AND url NOT IN (${placeholders})`,
      [params.trackedItemId, params.sourceKind, params.kind, ...params.urls],
    );
  }

  selectDownloadMirror(
    trackedItemId: string,
    url: string,
    kind?: 'full' | 'patch',
    sourceKind?: SupportedSourceKind | null,
  ): void {
    const now = new Date().toISOString();
    const selectedMirror = this.queryOne<{ kind: 'full' | 'patch' }>(
      kind
        ? sourceKind
          ? `SELECT kind FROM download_mirrors
             WHERE tracked_item_id = ? AND source_kind = ? AND url = ? AND kind = ?`
          : `SELECT kind FROM download_mirrors WHERE tracked_item_id = ? AND url = ? AND kind = ?`
        : sourceKind
          ? `SELECT kind FROM download_mirrors
           WHERE tracked_item_id = ? AND source_kind = ? AND url = ?
           ORDER BY CASE kind WHEN 'full' THEN 0 ELSE 1 END
           LIMIT 1`
          : `SELECT kind FROM download_mirrors
           WHERE tracked_item_id = ? AND url = ?
           ORDER BY CASE kind WHEN 'full' THEN 0 ELSE 1 END
           LIMIT 1`,
      kind
        ? sourceKind
          ? [trackedItemId, sourceKind, url, kind]
          : [trackedItemId, url, kind]
        : sourceKind
          ? [trackedItemId, sourceKind, url]
          : [trackedItemId, url],
    );
    if (!selectedMirror) {
      return;
    }
    this.exec(
      sourceKind
        ? `UPDATE download_mirrors
           SET selected_at = NULL
           WHERE tracked_item_id = ? AND source_kind = ? AND kind = ?`
        : `UPDATE download_mirrors
           SET selected_at = NULL
           WHERE tracked_item_id = ? AND kind = ?`,
      sourceKind
        ? [trackedItemId, sourceKind, selectedMirror.kind]
        : [trackedItemId, selectedMirror.kind],
    );
    this.exec(
      sourceKind
        ? `UPDATE download_mirrors
           SET selected_at = ?
           WHERE tracked_item_id = ? AND source_kind = ? AND url = ? AND kind = ?`
        : `UPDATE download_mirrors
           SET selected_at = ?
           WHERE tracked_item_id = ? AND url = ? AND kind = ?`,
      sourceKind
        ? [now, trackedItemId, sourceKind, url, selectedMirror.kind]
        : [now, trackedItemId, url, selectedMirror.kind],
    );
  }

  markDownloadMirrorFailed(
    trackedItemId: string,
    url: string,
    manuallyFailedAt: string | null,
  ): void {
    this.exec(
      `UPDATE download_mirrors
       SET manually_failed_at = ?
       WHERE tracked_item_id = ? AND url = ?`,
      [manuallyFailedAt, trackedItemId, url],
    );
  }

  getSteamMatch(trackedItemId: string): ConfirmedSteamMatch | null {
    const row = this.queryOne<{
      app_id: number;
      cover_url: string | null;
      matched_at: string;
      normalized_title: string;
      title: string;
    }>(`SELECT * FROM steam_matches WHERE tracked_item_id = ?`, [
      trackedItemId,
    ]);

    if (!row) {
      return null;
    }

    return {
      appId: Number(row.app_id),
      coverUrl: row.cover_url,
      matchedAt: row.matched_at,
      normalizedTitle: row.normalized_title,
      title: row.title,
    };
  }

  listSteamMatches(): Array<ConfirmedSteamMatch & { trackedItemId: string }> {
    return this.queryAll<{
      tracked_item_id: string;
      app_id: number;
      cover_url: string | null;
      matched_at: string;
      normalized_title: string;
      title: string;
    }>(`SELECT * FROM steam_matches`).map((row) => ({
      appId: Number(row.app_id),
      coverUrl: row.cover_url,
      matchedAt: row.matched_at,
      normalizedTitle: row.normalized_title,
      title: row.title,
      trackedItemId: row.tracked_item_id,
    }));
  }

  findSteamMatchByAppId(
    appId: number,
  ): (ConfirmedSteamMatch & { trackedItemId: string }) | null {
    return (
      this.listSteamMatches().find((match) => match.appId === appId) ?? null
    );
  }

  upsertSteamMatch(trackedItemId: string, match: ConfirmedSteamMatch): void {
    const duplicate = this.findSteamMatchByAppId(match.appId);
    if (duplicate && duplicate.trackedItemId !== trackedItemId) {
      throw new Error(
        `Steam app id ${match.appId} is already tracked by ${duplicate.trackedItemId}.`,
      );
    }
    this.exec(
      `INSERT INTO steam_matches (
         tracked_item_id, app_id, title, normalized_title, cover_url, matched_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id) DO UPDATE SET
         app_id = excluded.app_id,
         title = excluded.title,
         normalized_title = excluded.normalized_title,
         cover_url = COALESCE(excluded.cover_url, steam_matches.cover_url),
         matched_at = excluded.matched_at`,
      [
        trackedItemId,
        match.appId,
        match.title,
        match.normalizedTitle,
        match.coverUrl ?? null,
        match.matchedAt,
      ],
    );
  }

  listPatchEntries(trackedItemId: string): SteamPatchEntry[] {
    const rows = this.queryAll<{
      tracked_item_id: string;
      app_id: number;
      patch_title: string;
      build_id: string | null;
      description: string | null;
      patch_date: string;
      published_at: string | null;
      selection_source: SteamPatchEntry['selectionSource'] | null;
      version: string | null;
      link: string;
    }>(
      `SELECT tracked_item_id, app_id, patch_title, build_id, patch_date, published_at, link,
              version, description, selection_source
       FROM steam_patch_entries WHERE tracked_item_id = ?
       ORDER BY COALESCE(published_at, patch_date) DESC`,
      [trackedItemId],
    );
    return mergePatchHistory(
      rows.map((row) => ({
        appId: Number(row.app_id),
        buildId: row.build_id,
        description: row.description,
        link: row.link,
        patchDate: row.patch_date,
        patchTitle: row.patch_title,
        publishedAt: normalizePublishedAt(row.published_at, row.patch_date),
        selectionSource: row.selection_source,
        title: row.patch_title,
        trackedItemId: row.tracked_item_id,
        version: row.version,
      })),
    );
  }

  upsertPatchEntries(entries: SteamPatchEntry[]): void {
    for (const entry of entries) {
      this.exec(
        `INSERT OR IGNORE INTO steam_patch_entries (
           id, tracked_item_id, app_id, patch_title, build_id, patch_date, published_at,
           link, version, description, selection_source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomId(),
          entry.trackedItemId,
          entry.appId,
          entry.patchTitle,
          entry.buildId ?? null,
          entry.patchDate,
          entry.publishedAt,
          entry.link,
          entry.version ?? null,
          entry.description ?? null,
          entry.selectionSource ?? 'rss',
        ],
      );
      this.exec(
        `UPDATE steam_patch_entries
         SET app_id = ?, patch_title = ?, build_id = ?, patch_date = ?, published_at = ?,
             version = ?, description = ?, selection_source = ?
          WHERE tracked_item_id = ?
            AND COALESCE(build_id, '') = ?
            AND patch_date = ?
            AND link = ?`,
        [
          entry.appId,
          entry.patchTitle,
          entry.buildId ?? null,
          entry.patchDate,
          entry.publishedAt,
          entry.version ?? null,
          entry.description ?? null,
          entry.selectionSource ?? 'rss',
          entry.trackedItemId,
          entry.buildId ?? '',
          entry.patchDate,
          entry.link,
        ],
      );
    }
  }

  getSteamDbBuildCache(
    appId: number,
    nowIso = new Date().toISOString(),
  ): SteamDbBuildCacheRecord | null {
    const row = this.queryOne<{
      app_id: number;
      captured_at: string;
      expires_at: string;
      patches_json: string;
    }>(
      `SELECT app_id, patches_json, captured_at, expires_at
       FROM steamdb_build_cache
       WHERE app_id = ? AND expires_at > ?`,
      [appId, nowIso],
    );
    if (!row) {
      return null;
    }

    const patches = parseJsonArray<SteamPatchCandidate>(
      row.patches_json,
    ).filter((patch) => patch.appId === appId);
    if (patches.length === 0) {
      return null;
    }

    return {
      appId: Number(row.app_id),
      capturedAt: row.captured_at,
      expiresAt: row.expires_at,
      patches,
    };
  }

  upsertSteamDbBuildCache(record: SteamDbBuildCacheRecord): void {
    this.exec(
      `INSERT INTO steamdb_build_cache (
         app_id, patches_json, captured_at, expires_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         patches_json = excluded.patches_json,
         captured_at = excluded.captured_at,
         expires_at = excluded.expires_at`,
      [
        record.appId,
        JSON.stringify(record.patches),
        record.capturedAt,
        record.expiresAt,
      ],
    );
  }

  listSteamWishlistItems(): SteamWishlistCachedItem[] {
    return this.queryAll<{
      app_id: number;
      title: string;
      normalized_title: string;
      cover_url: string | null;
      store_url: string;
      release_date: string | null;
      review_summary: string | null;
      price_label: string | null;
      priority: number | null;
      date_added: string | null;
      last_seen_at: string;
    }>(
      `SELECT *
         FROM steam_wishlist_items
        ORDER BY COALESCE(date_added, last_seen_at) DESC, title ASC`,
    ).map((row) => ({
      appId: Number(row.app_id),
      coverUrl: row.cover_url,
      dateAdded: row.date_added,
      lastSeenAt: row.last_seen_at,
      normalizedTitle: row.normalized_title,
      priceLabel: row.price_label,
      priority: row.priority,
      releaseDate: row.release_date,
      reviewSummary: row.review_summary,
      storeUrl: row.store_url,
      title: row.title,
    }));
  }

  replaceSteamWishlistItems(items: SteamWishlistCachedItem[]): void {
    this.db.run(`DELETE FROM steam_wishlist_items`);
    for (const item of items) {
      this.db.run(
        `INSERT INTO steam_wishlist_items (
           app_id, title, normalized_title, cover_url, store_url, release_date,
           review_summary, price_label, priority, date_added, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.appId,
          item.title,
          item.normalizedTitle,
          item.coverUrl ?? null,
          item.storeUrl,
          item.releaseDate ?? null,
          item.reviewSummary ?? null,
          item.priceLabel ?? null,
          item.priority ?? null,
          item.dateAdded ?? null,
          item.lastSeenAt,
        ],
      );
    }
    this.save();
  }

  deleteSteamWishlistItem(appId: number): void {
    this.exec(`DELETE FROM steam_wishlist_items WHERE app_id = ?`, [appId]);
  }

  createSteamWishlistAction(record: {
    actionType: SteamWishlistActionType;
    appId?: number | null;
    trackedItemId?: string | null;
    title?: string | null;
  }): SteamWishlistRemovalRecord {
    const now = new Date().toISOString();
    const id = randomId();
    this.exec(
      `INSERT INTO steam_wishlist_actions (
         id, action_type, app_id, tracked_item_id, title, status, requested_at,
         completed_at, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.actionType,
        record.appId ?? null,
        record.trackedItemId ?? null,
        record.title ?? null,
        'pending',
        now,
        null,
        null,
      ],
    );
    return this.findSteamWishlistActionById(id)!;
  }

  findPendingSteamWishlistRemoval(appId: number): SteamWishlistRemovalRecord | null {
    return (
      this.listSteamWishlistActions('pending').find(
        (action) => action.actionType === 'remove' && action.appId === appId,
      ) ?? null
    );
  }

  findSteamWishlistActionById(id: string): SteamWishlistRemovalRecord | null {
    return (
      this.listSteamWishlistActions().find((action) => action.id === id) ??
      null
    );
  }

  listSteamWishlistActions(
    status?: SteamWishlistActionStatus,
  ): SteamWishlistRemovalRecord[] {
    const where = status ? `WHERE status = ?` : '';
    return this.queryAll<{
      id: string;
      action_type: SteamWishlistActionType;
      app_id: number | null;
      tracked_item_id: string | null;
      title: string | null;
      status: SteamWishlistActionStatus;
      requested_at: string;
      completed_at: string | null;
      error_message: string | null;
    }>(
      `SELECT *
         FROM steam_wishlist_actions
         ${where}
        ORDER BY requested_at DESC`,
      status ? [status] : [],
    ).map((row) => ({
      actionType: row.action_type,
      appId: row.app_id,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
      id: row.id,
      requestedAt: row.requested_at,
      status: row.status,
      title: row.title,
      trackedItemId: row.tracked_item_id,
    }));
  }

  listPendingSteamWishlistActions(params: {
    profileUrl?: string | null;
    steamId?: string | null;
  }): PendingSteamWishlistAction[] {
    return this.listSteamWishlistActions('pending').map((action) => ({
      actionType: action.actionType,
      appId: action.appId,
      id: action.id,
      profileUrl: params.profileUrl ?? null,
      requestedAt: action.requestedAt,
      steamId: params.steamId ?? null,
      title: action.title,
      trackedItemId: action.trackedItemId,
    }));
  }

  completeSteamWishlistAction(params: {
    actionId: string;
    errorMessage?: string | null;
    status: Exclude<SteamWishlistActionStatus, 'pending'>;
  }): SteamWishlistRemovalRecord {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE steam_wishlist_actions
          SET status = ?,
              completed_at = ?,
              error_message = ?
        WHERE id = ?`,
      [params.status, now, params.errorMessage ?? null, params.actionId],
    );
    const action = this.findSteamWishlistActionById(params.actionId);
    if (!action) {
      throw new Error(`Steam wishlist action ${params.actionId} not found`);
    }
    return action;
  }

  getSteamFeedCheck(trackedItemId: string): SteamFeedCheckRecord | null {
    const row = this.queryOne<{
      tracked_item_id: string;
      feed_url: string | null;
      last_checked_at: string | null;
      last_successful_at: string | null;
      last_error: string | null;
      updated_at: string;
    }>(`SELECT * FROM steam_feed_checks WHERE tracked_item_id = ?`, [
      trackedItemId,
    ]);
    return row
      ? {
          feedUrl: row.feed_url,
          lastCheckedAt: row.last_checked_at,
          lastError: row.last_error,
          lastSuccessfulAt: row.last_successful_at,
          trackedItemId: row.tracked_item_id,
          updatedAt: row.updated_at,
        }
      : null;
  }

  upsertSteamFeedCheck(record: SteamFeedCheckRecord): void {
    const existing = this.getSteamFeedCheck(record.trackedItemId);
    this.exec(
      `INSERT INTO steam_feed_checks (
         tracked_item_id, feed_url, last_checked_at, last_successful_at, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id) DO UPDATE SET
         feed_url = COALESCE(excluded.feed_url, steam_feed_checks.feed_url),
         last_checked_at = excluded.last_checked_at,
         last_successful_at = excluded.last_successful_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        record.trackedItemId,
        record.feedUrl ?? existing?.feedUrl ?? null,
        record.lastCheckedAt ?? null,
        record.lastSuccessfulAt ?? existing?.lastSuccessfulAt ?? null,
        record.lastError ?? null,
        record.updatedAt,
      ],
    );
  }

  getInstallRecord(trackedItemId: string): InstallRecord | null {
    const row = this.queryOne<{
      tracked_item_id: string;
      installed_version: string | null;
      installed_build_id: string | null;
      installed_at: string | null;
      install_path: string | null;
      installed_source_kind: SourceKind | null;
      installed_source_url: string | null;
      updated_at: string;
    }>(`SELECT * FROM install_records WHERE tracked_item_id = ?`, [
      trackedItemId,
    ]);
    return row
      ? {
          installedAt: row.installed_at,
          installedBuildId: row.installed_build_id,
          installPath: row.install_path,
          installedSourceKind: row.installed_source_kind,
          installedSourceUrl: row.installed_source_url,
          installedVersion: row.installed_version,
          trackedItemId: row.tracked_item_id,
          updatedAt: row.updated_at,
        }
      : null;
  }

  upsertInstallRecord(record: InstallRecord): void {
    this.exec(
      `INSERT INTO install_records (
         tracked_item_id, installed_version, installed_build_id, installed_at, install_path,
         installed_source_kind, installed_source_url, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id) DO UPDATE SET
         installed_version = excluded.installed_version,
         installed_build_id = excluded.installed_build_id,
         installed_at = excluded.installed_at,
         install_path = excluded.install_path,
         installed_source_kind = excluded.installed_source_kind,
         installed_source_url = excluded.installed_source_url,
         updated_at = excluded.updated_at`,
      [
        record.trackedItemId,
        record.installedVersion ?? null,
        record.installedBuildId ?? null,
        record.installedAt ?? null,
        record.installPath ?? null,
        record.installedSourceKind ?? null,
        record.installedSourceUrl ?? null,
        record.updatedAt,
      ],
    );
  }

  listInstallRecords(): InstallRecord[] {
    return this.queryAll<{
      tracked_item_id: string;
      installed_version: string | null;
      installed_build_id: string | null;
      installed_at: string | null;
      install_path: string | null;
      installed_source_kind: SourceKind | null;
      installed_source_url: string | null;
      updated_at: string;
    }>(`SELECT * FROM install_records`).map((row) => ({
      installPath: row.install_path,
      installedAt: row.installed_at,
      installedBuildId: row.installed_build_id,
      installedSourceKind: row.installed_source_kind,
      installedSourceUrl: row.installed_source_url,
      installedVersion: row.installed_version,
      trackedItemId: row.tracked_item_id,
      updatedAt: row.updated_at,
    }));
  }

  getPlayniteExecutableSelection(
    trackedItemId: string,
  ): PlayniteExecutableSelectionRecord | null {
    const row = this.queryOne<{
      candidates_json: string;
      confidence: string;
      reviewed_at: string | null;
      selected_exe_path: string | null;
      status: string;
      steam_app_id: number | null;
      tracked_item_id: string;
      updated_at: string;
    }>(
      `SELECT * FROM playnite_executable_selections WHERE tracked_item_id = ?`,
      [trackedItemId],
    );
    return row
      ? {
          candidates: normalizePlayniteExecutableCandidates(
            row.candidates_json,
          ),
          confidence: normalizePlayniteExecutableConfidence(row.confidence),
          reviewedAt: row.reviewed_at,
          selectedExePath: row.selected_exe_path,
          status: normalizePlayniteExecutableStatus(row.status),
          steamAppId: row.steam_app_id,
          trackedItemId: row.tracked_item_id,
          updatedAt: row.updated_at,
        }
      : null;
  }

  listPlayniteExecutableSelections(): PlayniteExecutableSelectionRecord[] {
    return this.queryAll<{
      candidates_json: string;
      confidence: string;
      reviewed_at: string | null;
      selected_exe_path: string | null;
      status: string;
      steam_app_id: number | null;
      tracked_item_id: string;
      updated_at: string;
    }>(`SELECT * FROM playnite_executable_selections`).map((row) => ({
      candidates: normalizePlayniteExecutableCandidates(row.candidates_json),
      confidence: normalizePlayniteExecutableConfidence(row.confidence),
      reviewedAt: row.reviewed_at,
      selectedExePath: row.selected_exe_path,
      status: normalizePlayniteExecutableStatus(row.status),
      steamAppId: row.steam_app_id,
      trackedItemId: row.tracked_item_id,
      updatedAt: row.updated_at,
    }));
  }

  upsertPlayniteExecutableSelection(
    record: PlayniteExecutableSelectionRecord,
  ): void {
    this.exec(
      `INSERT INTO playnite_executable_selections (
         tracked_item_id, steam_app_id, selected_exe_path, confidence, status,
         candidates_json, reviewed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id) DO UPDATE SET
         steam_app_id = excluded.steam_app_id,
         selected_exe_path = excluded.selected_exe_path,
         confidence = excluded.confidence,
         status = excluded.status,
         candidates_json = excluded.candidates_json,
         reviewed_at = excluded.reviewed_at,
         updated_at = excluded.updated_at`,
      [
        record.trackedItemId,
        record.steamAppId ?? null,
        record.selectedExePath ?? null,
        record.confidence,
        record.status,
        JSON.stringify(record.candidates),
        record.reviewedAt ?? null,
        record.updatedAt,
      ],
    );
  }

  getWatch(trackedItemId: string): SourceWatch | null {
    const row = this.queryOne<{
      tracked_item_id: string;
      started_at: string;
      ends_at: string;
      next_check_at: string;
      last_checked_at: string | null;
      expired_at: string | null;
    }>(`SELECT * FROM source_watches WHERE tracked_item_id = ?`, [
      trackedItemId,
    ]);
    return row
      ? {
          endsAt: row.ends_at,
          expiredAt: row.expired_at,
          lastCheckedAt: row.last_checked_at,
          nextCheckAt: row.next_check_at,
          startedAt: row.started_at,
          trackedItemId: row.tracked_item_id,
        }
      : null;
  }

  listDueWatches(
    nowIso: string,
    options: { includeExpired?: boolean } = {},
  ): SourceWatch[] {
    return this.queryAll<{
      tracked_item_id: string;
      started_at: string;
      ends_at: string;
      next_check_at: string;
      last_checked_at: string | null;
      expired_at: string | null;
    }>(
      `SELECT * FROM source_watches
       WHERE next_check_at <= ?
         AND (? = 1 OR expired_at IS NULL)`,
      [nowIso, options.includeExpired ? 1 : 0],
    ).map((row) => ({
      endsAt: row.ends_at,
      expiredAt: row.expired_at,
      lastCheckedAt: row.last_checked_at,
      nextCheckAt: row.next_check_at,
      startedAt: row.started_at,
      trackedItemId: row.tracked_item_id,
    }));
  }

  upsertWatch(watch: SourceWatch): void {
    this.exec(
      `INSERT INTO source_watches (
         tracked_item_id, started_at, ends_at, next_check_at, last_checked_at, expired_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tracked_item_id) DO UPDATE SET
         started_at = excluded.started_at,
         ends_at = excluded.ends_at,
         next_check_at = excluded.next_check_at,
         last_checked_at = excluded.last_checked_at,
         expired_at = excluded.expired_at`,
      [
        watch.trackedItemId,
        watch.startedAt,
        watch.endsAt,
        watch.nextCheckAt,
        watch.lastCheckedAt ?? null,
        watch.expiredAt ?? null,
      ],
    );
  }

  clearWatch(trackedItemId: string): void {
    this.exec(`DELETE FROM source_watches WHERE tracked_item_id = ?`, [
      trackedItemId,
    ]);
  }

  expireWatch(trackedItemId: string, expiredAt: string): void {
    const watch = this.getWatch(trackedItemId);
    if (!watch) {
      return;
    }
    this.upsertWatch({
      ...watch,
      expiredAt,
    });
  }

  getDownloadJob(trackedItemId: string): DownloadJobRecord | null {
    const row = this.queryOne<{
      id: string;
      tracked_item_id: string;
      source_kind: SupportedSourceKind | null;
      package_name: string;
      stage_path: string;
      final_path: string;
      stage: DownloadJobRecord['stage'];
      provider: string | null;
      package_id: number | null;
      selected_mirror_url: string | null;
      selected_patch_mirror_url: string | null;
      bytes_loaded: number | null;
      bytes_total: number | null;
      speed: number | null;
      eta_seconds: number | null;
      status_message: string | null;
      completed_parts: number | null;
      total_parts: number | null;
      created_at: string;
      updated_at: string;
      error_message: string | null;
    }>(
      `SELECT * FROM download_jobs WHERE tracked_item_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [trackedItemId],
    );
    return row
      ? {
          bytesLoaded: row.bytes_loaded,
          bytesTotal: row.bytes_total,
          completedParts: row.completed_parts,
          createdAt: row.created_at,
          etaSeconds: row.eta_seconds,
          errorMessage: row.error_message,
          finalPath: row.final_path,
          id: row.id,
          parts: this.listDownloadJobParts(row.id),
          packageId: row.package_id,
          packageName: row.package_name,
          provider:
            row.provider === 'embedded_browser' ||
            row.provider === 'direct_http'
              ? 'direct_http'
              : row.provider === 'manual'
                ? 'manual'
              : 'jdownloader',
          sourceKind: row.source_kind,
          selectedPatchMirrorUrl: row.selected_patch_mirror_url,
          selectedMirrorUrl: row.selected_mirror_url,
          speed: row.speed,
          stage: row.stage,
          stagePath: row.stage_path,
          statusMessage: row.status_message,
          totalParts: row.total_parts,
          trackedItemId: row.tracked_item_id,
          updatedAt: row.updated_at,
        }
      : null;
  }

  listDownloadJobs(): DownloadJobRecord[] {
    return this.queryAll<{
      id: string;
      tracked_item_id: string;
      source_kind: SupportedSourceKind | null;
      package_name: string;
      stage_path: string;
      final_path: string;
      stage: DownloadJobRecord['stage'];
      provider: string | null;
      package_id: number | null;
      selected_mirror_url: string | null;
      selected_patch_mirror_url: string | null;
      bytes_loaded: number | null;
      bytes_total: number | null;
      speed: number | null;
      eta_seconds: number | null;
      status_message: string | null;
      completed_parts: number | null;
      total_parts: number | null;
      created_at: string;
      updated_at: string;
      error_message: string | null;
    }>(`SELECT * FROM download_jobs ORDER BY updated_at DESC`).map((row) => ({
      bytesLoaded: row.bytes_loaded,
      bytesTotal: row.bytes_total,
      completedParts: row.completed_parts,
      createdAt: row.created_at,
      etaSeconds: row.eta_seconds,
      errorMessage: row.error_message,
      finalPath: row.final_path,
      id: row.id,
      parts: this.listDownloadJobParts(row.id),
      packageId: row.package_id,
      packageName: row.package_name,
      provider:
        row.provider === 'embedded_browser' || row.provider === 'direct_http'
          ? 'direct_http'
          : row.provider === 'manual'
            ? 'manual'
            : 'jdownloader',
      sourceKind: row.source_kind,
      selectedPatchMirrorUrl: row.selected_patch_mirror_url,
      selectedMirrorUrl: row.selected_mirror_url,
      speed: row.speed,
      stage: row.stage,
      stagePath: row.stage_path,
      statusMessage: row.status_message,
      totalParts: row.total_parts,
      trackedItemId: row.tracked_item_id,
      updatedAt: row.updated_at,
    }));
  }

  listDownloadJobsForTrackedItem(trackedItemId: string): DownloadJobRecord[] {
    return this.listDownloadJobs().filter(
      (job) => job.trackedItemId === trackedItemId,
    );
  }

  listDownloadJobParts(jobId: string): DownloadJobPartRecord[] {
    return this.queryAll<{
      id: string;
      job_id: string;
      tracked_item_id: string;
      role: 'full' | 'patch';
      package_name: string;
      mirror_url: string | null;
      stage: DownloadJobPartRecord['stage'];
      package_id: number | null;
      bytes_loaded: number | null;
      bytes_total: number | null;
      speed: number | null;
      eta_seconds: number | null;
      status_message: string | null;
      error_message: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT * FROM download_job_parts
       WHERE job_id = ?
       ORDER BY CASE role WHEN 'full' THEN 0 WHEN 'patch' THEN 1 ELSE 2 END`,
      [jobId],
    ).map((row) => ({
      bytesLoaded: row.bytes_loaded,
      bytesTotal: row.bytes_total,
      createdAt: row.created_at,
      errorMessage: row.error_message,
      etaSeconds: row.eta_seconds,
      id: row.id,
      jobId: row.job_id,
      mirrorUrl: row.mirror_url,
      packageId: row.package_id,
      packageName: row.package_name,
      role: row.role,
      speed: row.speed,
      stage: row.stage,
      statusMessage: row.status_message,
      trackedItemId: row.tracked_item_id,
      updatedAt: row.updated_at,
    }));
  }

  upsertDownloadJobPart(part: DownloadJobPartRecord): void {
    this.exec(
      `INSERT INTO download_job_parts (
         id, job_id, tracked_item_id, role, package_name, mirror_url, stage, package_id,
         bytes_loaded, bytes_total, speed, eta_seconds, status_message, error_message,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, role) DO UPDATE SET
          tracked_item_id = excluded.tracked_item_id,
          package_name = excluded.package_name,
          mirror_url = excluded.mirror_url,
          stage = excluded.stage,
          package_id = excluded.package_id,
          bytes_loaded = excluded.bytes_loaded,
          bytes_total = excluded.bytes_total,
          speed = excluded.speed,
          eta_seconds = excluded.eta_seconds,
          status_message = excluded.status_message,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at`,
      [
        part.id,
        part.jobId,
        part.trackedItemId,
        part.role,
        part.packageName,
        part.mirrorUrl ?? null,
        part.stage,
        part.packageId ?? null,
        part.bytesLoaded ?? null,
        part.bytesTotal ?? null,
        part.speed ?? null,
        part.etaSeconds ?? null,
        part.statusMessage ?? null,
        part.errorMessage ?? null,
        part.createdAt,
        part.updatedAt,
      ],
    );
  }

  upsertDownloadJob(job: DownloadJobRecord): void {
    this.exec(
      `INSERT INTO download_jobs (
         id, tracked_item_id, source_kind, package_name, stage_path, final_path, stage, provider, package_id, selected_mirror_url,
          selected_patch_mirror_url, bytes_loaded, bytes_total, speed, eta_seconds, status_message,
          completed_parts, total_parts, created_at, updated_at, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
          tracked_item_id = excluded.tracked_item_id,
          source_kind = excluded.source_kind,
          package_name = excluded.package_name,
          stage_path = excluded.stage_path,
          final_path = excluded.final_path,
          stage = excluded.stage,
          provider = excluded.provider,
          package_id = excluded.package_id,
          selected_mirror_url = excluded.selected_mirror_url,
          selected_patch_mirror_url = excluded.selected_patch_mirror_url,
          bytes_loaded = excluded.bytes_loaded,
          bytes_total = excluded.bytes_total,
          speed = excluded.speed,
          eta_seconds = excluded.eta_seconds,
          status_message = excluded.status_message,
          completed_parts = excluded.completed_parts,
          total_parts = excluded.total_parts,
          updated_at = excluded.updated_at,
          error_message = excluded.error_message`,
      [
        job.id,
        job.trackedItemId,
        job.sourceKind ?? null,
        job.packageName,
        job.stagePath,
        job.finalPath,
        job.stage,
        job.provider ?? 'jdownloader',
        job.packageId ?? null,
        job.selectedMirrorUrl ?? null,
        job.selectedPatchMirrorUrl ?? null,
        job.bytesLoaded ?? null,
        job.bytesTotal ?? null,
        job.speed ?? null,
        job.etaSeconds ?? null,
        job.statusMessage ?? null,
        job.completedParts ?? null,
        job.totalParts ?? null,
        job.createdAt,
        job.updatedAt,
        job.errorMessage ?? null,
      ],
    );
    if (job.parts) {
      if (job.parts.length === 0) {
        this.exec(`DELETE FROM download_job_parts WHERE job_id = ?`, [job.id]);
      } else {
        const placeholders = job.parts.map(() => '?').join(', ');
        this.exec(
          `DELETE FROM download_job_parts
           WHERE job_id = ?
             AND role NOT IN (${placeholders})`,
          [job.id, ...job.parts.map((part) => part.role)],
        );
      }
    }
    for (const part of job.parts ?? []) {
      this.upsertDownloadJobPart(part);
    }
  }

  deleteDownloadJob(jobId: string): void {
    this.exec(`DELETE FROM download_job_parts WHERE job_id = ?`, [jobId]);
    this.exec(`DELETE FROM download_jobs WHERE id = ?`, [jobId]);
  }

  deleteDownloadJobsForTrackedItem(
    trackedItemId: string,
    options: { includeComplete?: boolean } = {},
  ): void {
    const jobs = this.listDownloadJobsForTrackedItem(trackedItemId).filter(
      (job) => options.includeComplete || job.stage !== 'complete',
    );
    for (const job of jobs) {
      this.deleteDownloadJob(job.id);
    }
  }

  dismissActivityIssue(params: {
    dismissedAt: string;
    issueId: string;
    issueKey: string;
    trackedItemId?: string | null;
  }): void {
    this.exec(
      `INSERT INTO activity_issue_dismissals (
         issue_key, issue_id, tracked_item_id, dismissed_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(issue_key) DO UPDATE SET
          issue_id = excluded.issue_id,
          tracked_item_id = excluded.tracked_item_id,
          dismissed_at = excluded.dismissed_at`,
      [
        params.issueKey,
        params.issueId,
        params.trackedItemId ?? null,
        params.dismissedAt,
      ],
    );
  }

  listDismissedActivityIssueKeys(): Set<string> {
    return new Set(
      this.queryAll<{ issue_key: string }>(
        `SELECT issue_key FROM activity_issue_dismissals`,
      ).map((row) => row.issue_key),
    );
  }

  deleteTrackedItemCascade(trackedItemId: string): void {
    const childTables = [
      'source_watches',
      'install_records',
      'playnite_executable_selections',
      'source_matches',
      'source_snapshots',
      'steam_matches',
      'steam_patch_entries',
      'steam_feed_checks',
      'download_mirrors',
      'download_job_parts',
      'download_jobs',
      'activity_issue_dismissals',
    ];

    for (const table of childTables) {
      this.exec(`DELETE FROM ${table} WHERE tracked_item_id = ?`, [
        trackedItemId,
      ]);
    }
    this.exec(`DELETE FROM tracked_items WHERE id = ?`, [trackedItemId]);
  }

  getSettings(): SettingsRecord & {
    encryptedPassword?: string | null;
    lastDailyPollAt?: string | null;
  } {
    const rows = this.queryAll<{ key: string; value: string | null }>(
      `SELECT * FROM settings`,
    );
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const legacyRootPath = map.get('library.rootPath') ?? null;
    const libraryRoots = normalizeLibraryRoots(
      parseJsonArray<LibraryRootRecord>(map.get('library.roots')),
      legacyRootPath,
    );
    const primaryRoot = libraryRoots.find((root) => root.isPrimary) ?? null;
    const ignoredImportFolders = parseJsonArray<IgnoredImportFolderRecord>(
      map.get('import.ignoredFolders'),
    ).filter(
      (entry) =>
        typeof entry.id === 'string' &&
        typeof entry.rootPath === 'string' &&
        typeof entry.folderName === 'string',
    );
    return {
      encryptedPassword: map.get('myjd.password') ?? null,
      ignoredImportFolders,
      jDownloaderEnabled: getDefaultJDownloaderEnabled(map),
      jDownloaderSourcePreferences: normalizeJDownloaderSourcePreferences(
        map.get('download.jdownloader.sources'),
      ),
      lastDailyPollAt: map.get('scheduler.lastDailyPollAt') ?? null,
      libraryRoots,
      lastExtensionActivityAt:
        map.get('extension.lastNativeMessageAt') ?? null,
      myJDownloaderDeviceId: map.get('myjd.deviceId') ?? null,
      myJDownloaderEmail: map.get('myjd.email') ?? null,
      onboarding: parseJsonObject<OnboardingState>(
        map.get('onboarding.state'),
      ),
      pollDailyHourLocal: Number(map.get('scheduler.pollDailyHourLocal') ?? 9),
      playniteExtensionsPath:
        map.get('playnite.extensionsPath')?.trim() || null,
      playniteIntegrationEnabled:
        map.get('playnite.integrationEnabled') === 'true',
      playniteManifestPath: map.get('playnite.manifestPath')?.trim() || null,
      playnitePluginInstalledAt:
        map.get('playnite.pluginInstalledAt') ?? null,
      playnitePluginVersion: map.get('playnite.pluginVersion') ?? null,
      renameGameFoldersOnImport:
        map.get('import.renameGameFoldersOnImport') !== 'false',
      rootLibraryPath: primaryRoot?.path ?? legacyRootPath,
      sourceWatchDurationDays: Number(map.get('sourceWatch.durationDays') ?? 5),
      sourceWatchIntervalHours: Number(
        map.get('sourceWatch.intervalHours') ?? 8,
      ),
      themeMode: normalizeThemeMode(map.get('appearance.themeMode')),
    };
  }

  setSetting(key: string, value: string | null): void {
    this.exec(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  getSetting(key: string): string | null {
    return (
      this.queryOne<{ value: string | null }>(
        `SELECT value FROM settings WHERE key = ?`,
        [key],
      )?.value ?? null
    );
  }

  appendEvent(event: Omit<EventLogRecord, 'id' | 'createdAt'>): void {
    this.exec(
      `INSERT INTO event_log (id, level, message, context_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        randomId(),
        event.level,
        event.message,
        JSON.stringify(event.context ?? null),
        new Date().toISOString(),
      ],
    );
  }

  listEvents(limit = 100): EventLogRecord[] {
    return this.queryAll<{
      id: string;
      level: EventLogRecord['level'];
      message: string;
      context_json: string | null;
      created_at: string;
    }>(`SELECT * FROM event_log ORDER BY created_at DESC LIMIT ?`, [limit]).map(
      (row) => ({
        context: row.context_json
          ? (JSON.parse(row.context_json) as Record<string, unknown>)
          : undefined,
        createdAt: row.created_at,
        id: row.id,
        level: row.level,
        message: row.message,
      }),
    );
  }
}
