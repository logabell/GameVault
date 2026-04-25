interface SteamDbChallengeDetectionInput {
  pageText: string;
  title: string;
}

interface SteamDbChallengeDetection {
  message: string;
}

export function detectSteamDbChallenge(
  input: SteamDbChallengeDetectionInput,
): SteamDbChallengeDetection | null {
  const combined = `${input.title}\n${input.pageText}`;
  if (
    /just a moment/i.test(combined) ||
    /checking your browser/i.test(combined) ||
    /verify you are human/i.test(combined) ||
    (/cloudflare/i.test(combined) &&
      /challenge|checking|human|security|verify/i.test(combined))
  ) {
    return {
      message: 'Cloudflare validation needed. Complete the browser check to continue.',
    };
  }

  return null;
}
