import { describe, expect, it } from 'vitest';

import type { ActivityView } from '@gamevault/shared-types';
import {
  buildActivityReport,
  getActivityLogContextRows,
  sortActivityIssues,
} from '../src/renderer/activity-report.js';

const activity: ActivityView = {
  activeTasks: [],
  generatedAt: '2026-04-24T12:00:00.000Z',
  issues: [
    {
      detail: 'Warning detail',
      id: 'warning',
      kind: 'steamdb_stale',
      severity: 'warning',
      title: 'Warning issue',
    },
    {
      detail: 'Error detail',
      id: 'error',
      kind: 'download_failed',
      severity: 'error',
      title: 'Error issue',
    },
  ],
  logs: [
    {
      context: {
        error: 'Failed at C:\\Users\\Logan\\Vault\\game',
        password: 'secret',
        trackedItemId: 'item-1',
      },
      createdAt: '2026-04-24T11:59:00.000Z',
      id: 'log-1',
      level: 'error',
      message: 'Download failed',
    },
  ],
  summary: [
    {
      detail: 'No warning or error events in the last 24 hours.',
      id: 'automationErrors',
      label: 'Automation Errors',
      status: 'ok',
      value: 'Clear',
    },
  ],
};

describe('activity report helpers', () => {
  it('sorts activity issues by severity first', () => {
    expect(sortActivityIssues(activity.issues).map((issue) => issue.id)).toEqual([
      'error',
      'warning',
    ]);
  });

  it('renders readable log context without secret keys', () => {
    const rows = getActivityLogContextRows(activity.logs[0]!);

    expect(rows.map((row) => row.label)).toEqual([
      'Error',
      'TrackedItemId',
    ]);
    expect(rows[0]?.value).toContain('%USERPROFILE%');
  });

  it('builds a sanitized copyable diagnostics report', () => {
    const report = buildActivityReport({
      activity,
      settings: {
        myJDownloaderPasswordConfigured: true,
        pollDailyHourLocal: 9,
        sourceWatchDurationDays: 5,
        sourceWatchIntervalHours: 8,
      },
    });

    expect(report).toContain('GameVault Activity Report');
    expect(report).toContain('[ERROR] Error issue');
    expect(report).toContain('%USERPROFILE%');
    expect(report).not.toContain('secret');
    expect(report).not.toContain('Logan');
  });
});
