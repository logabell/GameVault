import type {
  ActivityIssue,
  ActivityTask,
  ActivityView,
  EventLogRecord,
  SettingsView,
} from '@gamevault/shared-types';

const SECRET_KEY_PATTERN =
  /(password|token|secret|credential|authorization|cookie|session)/i;
const USER_HOME_PATTERN = /[a-z]:\\users\\[^\s\\]+|\/users\/[^\s/]+/gi;

function formatLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function sanitizeString(value: string): string {
  return value.replace(USER_HOME_PATTERN, (match) =>
    match.includes('\\') ? '%USERPROFILE%' : '~',
  );
}

function sanitizeActivityReportValue(
  value: unknown,
  keyHint = '',
): unknown {
  if (SECRET_KEY_PATTERN.test(keyHint)) {
    return '[redacted]';
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeActivityReportValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizeActivityReportValue(entry, key),
      ]),
    );
  }

  return value;
}

function getActivityIssueRank(issue: ActivityIssue): number {
  if (issue.severity === 'error') return 0;
  if (issue.severity === 'warning') return 1;
  return 2;
}

export function sortActivityIssues(
  issues: ActivityIssue[],
): ActivityIssue[] {
  return [...issues].sort((left, right) => {
    const severityDelta =
      getActivityIssueRank(left) - getActivityIssueRank(right);
    if (severityDelta !== 0) return severityDelta;

    const leftTime = new Date(left.createdAt ?? 0).getTime();
    const rightTime = new Date(right.createdAt ?? 0).getTime();
    return rightTime - leftTime;
  });
}

export interface NavbarAutomationStatus {
  detail: string;
  label: string;
  status: 'running';
}

const NAVBAR_SYNC_TASK_IDS = new Set([
  'startup-catch-up',
  'steamdb-feeds',
  'source-watches',
]);

export function getActivityTaskProgressLabel(
  task: ActivityTask,
): string | null {
  const current = task.progressCurrent;
  const total = task.progressTotal;
  if (
    typeof current !== 'number' ||
    typeof total !== 'number' ||
    total <= 0
  ) {
    return null;
  }
  return `${Math.max(0, Math.min(current, total))}/${total}`;
}

export function getNavbarAutomationStatus(
  activity: ActivityView | null,
): NavbarAutomationStatus | null {
  const activeTask =
    activity?.activeTasks.find((task) => NAVBAR_SYNC_TASK_IDS.has(task.id)) ??
    null;
  if (!activeTask) {
    return null;
  }

  const progressLabel = getActivityTaskProgressLabel(activeTask);
  return {
    detail: activeTask.detail ?? activeTask.title,
    label: progressLabel ? `Syncing updates ${progressLabel}` : 'Syncing updates',
    status: 'running',
  };
}

export function getActivityLogContextRows(
  log: EventLogRecord,
): Array<{ label: string; value: string }> {
  const context = log.context ?? {};
  return Object.entries(context)
    .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
    .map(([key, value]) => {
      const sanitized = sanitizeActivityReportValue(value, key);
      return {
        label: formatLabel(key),
        value:
          typeof sanitized === 'string'
            ? sanitized
            : JSON.stringify(sanitized),
      };
    });
}

export function buildActivityReport(params: {
  activity: ActivityView;
  settings: SettingsView;
}): string {
  const { activity, settings } = params;
  const warningLogs = activity.logs.filter((log) => log.level !== 'info');
  const lines = [
    'GameVault Activity Report',
    `Generated: ${activity.generatedAt}`,
    '',
    'Scheduler Settings',
    `Daily SteamDB hour: ${settings.pollDailyHourLocal ?? 9}`,
    `Source watch interval hours: ${settings.sourceWatchIntervalHours ?? 8}`,
    `Source watch duration days: ${settings.sourceWatchDurationDays ?? 5}`,
    '',
    'Summary',
    ...activity.summary.map(
      (card) =>
        `- ${card.label}: ${card.value} (${formatLabel(card.status)}) - ${card.detail}`,
    ),
    '',
    'Maintenance Heartbeats',
    ...(activity.heartbeats?.length
      ? activity.heartbeats.map(
          (heartbeat) =>
            `- ${formatLabel(heartbeat.scope)}: ${formatLabel(heartbeat.status)} - ${heartbeat.detail ?? 'No detail'}${heartbeat.error ? ` (${heartbeat.error})` : ''}`,
        )
      : ['- None']),
    '',
    'Maintenance Jobs',
    ...(activity.maintenanceJobs?.length
      ? activity.maintenanceJobs.slice(0, 25).map((job) => {
          const target =
            job.gameTitle ?? job.sourceKind ?? job.host ?? 'unscoped';
          const retry =
            job.retryInMs && job.retryInMs > 0
              ? `; retryInMs: ${job.retryInMs}`
              : '';
          const error = job.lastError ? `; error: ${job.lastError}` : '';
          const attempts =
            job.kind === 'download_poll'
              ? ''
              : `; attempts: ${job.attemptCount}`;
          return `- [${formatLabel(job.status)}] ${formatLabel(job.kind)} ${target}${attempts}${retry}${error}`;
        })
      : ['- None']),
    '',
    'Issues',
    ...(activity.issues.length
      ? sortActivityIssues(activity.issues).map(
          (issue) =>
            `- [${issue.severity.toUpperCase()}] ${issue.title}: ${issue.detail}`,
        )
      : ['- None']),
    '',
    'Recent Warning/Error Logs',
    ...(warningLogs.length
      ? warningLogs.map((log) => {
          const contextRows = getActivityLogContextRows(log);
          const context = contextRows.length
            ? ` | ${contextRows
                .map((row) => `${row.label}: ${row.value}`)
                .join('; ')}`
            : '';
          return `- [${log.level.toUpperCase()}] ${log.createdAt} ${log.message}${context}`;
        })
      : ['- None']),
  ];

  return sanitizeActivityReportValue(lines.join('\n')) as string;
}
