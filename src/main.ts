import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { Store } from "./db.ts";

const config = configFromEnv();
const store = new Store(config.dbPath);
const app = createApp(store, config);

const server = serve({ fetch: app.fetch, port: config.port }, info => console.log(`myriad-api on :${info.port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close();
		store.close();
		process.exit(0);
	});
}
