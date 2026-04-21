import { describe, expect, it } from 'vitest';

import { detectSteamDbChallenge } from '../src/steamdb-challenge.js';

describe('SteamDB challenge detection', () => {
  it('detects Just a moment titles', () => {
    expect(
      detectSteamDbChallenge({
        pageText: '',
        title: 'Just a moment...',
      }),
    ).toMatchObject({
      message: expect.stringContaining('Cloudflare validation needed'),
    });
  });

  it('detects browser checking copy', () => {
    expect(
      detectSteamDbChallenge({
        pageText: 'Checking your browser before accessing steamdb.info',
        title: 'SteamDB',
      }),
    ).toBeTruthy();
  });

  it('detects visible Cloudflare human verification copy', () => {
    expect(
      detectSteamDbChallenge({
        pageText: 'Verify you are human CLOUDFLARE Privacy Help',
        title: 'SteamDB',
      }),
    ).toBeTruthy();
  });

  it('does not flag ordinary SteamDB pages', () => {
    expect(
      detectSteamDbChallenge({
        pageText: 'Patches Builds Price history Charts',
        title: 'Patch notes · SteamDB',
      }),
    ).toBeNull();
  });
});
