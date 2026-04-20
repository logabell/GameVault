import type {
  ConfirmedSteamMatch,
  SteamCandidate,
} from '@vaulttrack/shared-types';

type RankableSteamCandidate = Omit<
  SteamCandidate,
  'normalizedTitle' | 'score' | 'reasons'
> &
  Partial<Pick<SteamCandidate, 'matchedQuery' | 'source'>>;

const MIN_RELEVANT_STEAM_SCORE = 0.18;
const EDITION_NOISE_RE =
  /\b(?:game of the year|goty|deluxe|ultimate|complete|collector'?s?|gold|premium|special|standard|definitive|enhanced|anniversary|digital|supporter)\s+(?:edition|upgrade|bundle|pack)\b/gi;
const STANDALONE_NOISE_RE =
  /\b(?:game of the year|goty|deluxe|ultimate|complete|collector'?s?|gold|premium|special|standard|definitive|enhanced|anniversary|digital|supporter|edition|bundle|upgrade|build)\b/gi;
const NON_BASE_GAME_RE =
  /\b(?:deluxe edition upgrade|upgrade|soundtrack|ost|demo|playtest|dedicated server|server|editor|tool|dlc|season pass|expansion pass)\b/i;

function compactTitle(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function stripDanglingSeparators(input: string): string {
  return input
    .replace(/\s*[:|/-]\s*$/g, '')
    .replace(/^\s*[:|/-]\s*/g, '')
    .trim();
}

function stripEditionNoise(input: string): string {
  return stripDanglingSeparators(
    compactTitle(input)
      .replace(EDITION_NOISE_RE, ' ')
      .replace(STANDALONE_NOISE_RE, ' ')
      .replace(/\s+[:|/-]\s+/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

function uniqueSearchTexts(inputs: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const input of inputs) {
    const compacted = compactTitle(input);
    const searchKey = compacted.toLowerCase();
    const normalized = normalizeSteamTitle(compacted);
    if (!compacted || !normalized || seen.has(searchKey)) {
      continue;
    }

    seen.add(searchKey);
    unique.push(compacted);
  }

  return unique;
}

export function normalizeSteamTitle(input: string): string {
  return stripEditionNoise(input)
    .toLowerCase()
    .replace(/['`\u2018\u2019\u201a\u201b\u00b4]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(
      /\b(game of the year|goty|edition|complete|bundle|build|upgrade)\b/g,
      '',
    )
    .trim()
    .replace(/\s+/g, ' ');
}

export function buildSteamSearchQueries(input: string): string[] {
  const compacted = compactTitle(input);
  const stripped = stripEditionNoise(compacted);
  return uniqueSearchTexts([stripped, compacted]);
}

function tokenize(input: string): Set<string> {
  return new Set(normalizeSteamTitle(input).split(' ').filter(Boolean));
}

function meaningfulTokens(input: Set<string>): Set<string> {
  return new Set([...input].filter((token) => !/^\d+$/.test(token)));
}

function jaccardScore(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  return [...left].filter((token) => right.has(token)).length;
}

function prefixBoost(query: string, candidate: string): number {
  if (candidate === query) {
    return 0.25;
  }

  if (candidate.startsWith(query)) {
    return 0.15;
  }

  return 0;
}

function orderedContainmentBoost(query: string, candidate: string): number {
  if (!query || !candidate || query === candidate) {
    return 0;
  }

  if (candidate.includes(query)) {
    return 0.22;
  }

  if (query.includes(candidate)) {
    return 0.12;
  }

  return 0;
}

export function isLikelyNonBaseSteamTitle(title: string): boolean {
  return NON_BASE_GAME_RE.test(title);
}

export function rankSteamCandidates(
  query: string,
  rawCandidates: RankableSteamCandidate[],
): SteamCandidate[] {
  const normalizedQuery = normalizeSteamTitle(query);
  const queryTokens = tokenize(query);
  const queryMeaningfulTokens = meaningfulTokens(queryTokens);

  return rawCandidates
    .map((candidate) => {
      const normalizedCandidate = normalizeSteamTitle(candidate.title);
      const candidateTokens = tokenize(candidate.title);
      const candidateMeaningfulTokens = meaningfulTokens(candidateTokens);
      const reasons: string[] = [];
      let score = jaccardScore(queryTokens, candidateTokens);
      const meaningfulOverlap = overlapCount(
        queryMeaningfulTokens,
        candidateMeaningfulTokens,
      );

      if (queryMeaningfulTokens.size > 0 && meaningfulOverlap === 0) {
        reasons.push('no_meaningful_token_overlap');
        score = 0;
      }

      const boost = prefixBoost(normalizedQuery, normalizedCandidate);
      if (boost > 0) {
        reasons.push('prefix_match');
        score += boost;
      }

      const containmentBoost = orderedContainmentBoost(
        normalizedQuery,
        normalizedCandidate,
      );
      if (containmentBoost > 0) {
        reasons.push('ordered_title_containment');
        score += containmentBoost;
      }

      if (normalizedCandidate === normalizedQuery) {
        reasons.push('exact_normalized_match');
        score += 0.4;
      }

      if (/\b\d{4}\b/.test(candidate.title) && !/\b\d{4}\b/.test(query)) {
        reasons.push('year_penalty');
        score -= 0.12;
      }

      if (candidate.title.includes(':')) {
        reasons.push('subtitle_penalty');
        score -= 0.05;
      }

      if (isLikelyNonBaseSteamTitle(candidate.title)) {
        reasons.push('non_base_game_penalty');
        score = Math.min(score - 0.25, 0.42);
      }

      return {
        ...candidate,
        normalizedTitle: normalizedCandidate,
        reasons,
        score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
      };
    })
    .sort((left, right) => right.score - left.score);
}

export function filterRelevantSteamCandidates(
  candidates: SteamCandidate[],
): SteamCandidate[] {
  return candidates.filter(
    (candidate) => candidate.score >= MIN_RELEVANT_STEAM_SCORE,
  );
}

export function shouldAutoSelect(topCandidates: SteamCandidate[]): boolean {
  const [top, second] = topCandidates;
  if (!top) {
    return false;
  }

  if (top.score < 0.88) {
    return false;
  }

  return !second || top.score - second.score >= 0.1;
}

export function confirmSteamMatch(
  candidate: SteamCandidate,
): ConfirmedSteamMatch {
  return {
    appId: candidate.appId,
    coverUrl: candidate.coverUrl,
    matchedAt: new Date().toISOString(),
    normalizedTitle: candidate.normalizedTitle,
    title: candidate.title,
  };
}
