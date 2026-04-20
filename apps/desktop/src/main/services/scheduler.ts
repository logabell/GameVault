import { VaultTrackService } from './vaulttrack-service.js';

export class VaultTrackScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly service: VaultTrackService) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const tick = async () => {
      const settings = this.service.getSettings();
      const now = new Date();
      const lastPoll = this.service.getLatestDailyPollAt();
      const lastPollDate = lastPoll ? new Date(lastPoll) : null;
      const shouldPollDaily =
        now.getHours() >= (settings.pollDailyHourLocal ?? 9) &&
        (!lastPollDate || lastPollDate.toDateString() !== now.toDateString());

      if (shouldPollDaily) {
        await this.service.pollSteamFeeds();
      }

      await this.service.processDueWatches(now);
      await this.service.pollDownloadJobs();
    };

    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
