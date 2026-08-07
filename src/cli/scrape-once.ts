import { assertLiveConfig, config } from "../config.js";
import { Store } from "../db/store.js";
import { createLeadfloClient } from "../leadflo/index.js";
import { Poller } from "../services/poller.js";

assertLiveConfig();

const store = new Store();
const client = createLeadfloClient();
const poller = new Poller({ store, client });

const result = await poller.tick();
console.log(
  JSON.stringify(
    {
      mode: config.leadflo.mode,
      ...result,
      error: poller.lastError,
      latestPoll: store.latestPollRun(),
    },
    null,
    2,
  ),
);
store.close();
if (poller.lastError) process.exitCode = 1;
