const { writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
if (process.env.ANKERGAMES_LIVE_RESULT_PATH) {
  writeFileSync(`${process.env.ANKERGAMES_LIVE_RESULT_PATH}.started`, 'started\n');
}

const keepAlive = setInterval(() => undefined, 1_000);
import(pathToFileURL(join(__dirname, 'ankergames-live-resolver.mjs')).href)
  .catch((error) => {
    if (process.env.ANKERGAMES_LIVE_RESULT_PATH) {
      writeFileSync(
        process.env.ANKERGAMES_LIVE_RESULT_PATH,
        `${JSON.stringify({ error: error instanceof Error ? error.stack || error.message : String(error) }, null, 2)}\n`,
      );
    }
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
  })
  .finally(() => {
    clearInterval(keepAlive);
});
