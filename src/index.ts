import { assertLiveConfig, config } from "./config.js";
import { createApp } from "./app.js";
import { Store } from "./db/store.js";
import { createLeadfloClient } from "./leadflo/index.js";
import { loadOverrides } from "./runtime-settings.js";
import { Poller } from "./services/poller.js";

assertLiveConfig();

const store = new Store();
// Before anything reads config: a stored override only takes effect once loaded.
loadOverrides(store.allSettings());

const client = createLeadfloClient();
const poller = new Poller({ store, client });
const app = createApp({ store, poller, client });

const server = app.listen(config.port, config.host, () => {
  const base = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  poller.publicBaseUrl = process.env.PUBLIC_BASE_URL || base;
  console.log(`Leadflo dashboard listening on ${base}`);
  console.log(
    `Mode=${config.leadflo.mode} | types=${config.trackedTreatmentTypes.join(",")} | poll=${config.pollIntervalMs}ms | notesOnlyTest=${config.notesOnlyTestNames}`,
  );
  poller.start();
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down…`);
  poller.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
