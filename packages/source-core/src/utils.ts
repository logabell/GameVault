export function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\b(the|edition|complete|build)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ddmmyyyyToMmddyyyy(input: string | undefined | null): string | null {
  if (!input) {
    return null;
  }

  const match = input.match(/(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})/);
  if (!match?.groups) {
    return null;
  }

  return `${match.groups.month}/${match.groups.day}/${match.groups.year}`;
}

export function normalizeSlashDate(input: string | undefined | null): string | null {
  if (!input) {
    return null;
  }

  const dotDate = ddmmyyyyToMmddyyyy(input);
  if (dotDate) {
    return dotDate;
  }

  const slashMatch = input.match(/(?<month>\d{1,2})\/(?<day>\d{1,2})\/(?<year>\d{4})/);
  if (slashMatch?.groups) {
    return `${slashMatch.groups.month.padStart(2, '0')}/${slashMatch.groups.day.padStart(2, '0')}/${slashMatch.groups.year}`;
  }

  return null;
}

export function compactText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function buildFingerprint(parts: Array<string | null | undefined>): string {
  const payload = parts.filter(Boolean).join('|');
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
