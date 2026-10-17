import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { Store } from "./db.ts";

const config = configFromEnv();
const store = new Store(config.dbPath);
const app = createApp(store, config);

const server = serve({ fetch: app.fetch, port: config.port }, info => console.log(`myriad-api on :${info.port}`));
// Slow clients can't hold connections open: a request has 10 seconds to arrive whole.
const http = server as unknown as { headersTimeout: number; requestTimeout: number; keepAliveTimeout: number };
http.headersTimeout = 10_000;
http.requestTimeout = 10_000;
http.keepAliveTimeout = 5_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		server.close();
		store.close();
		process.exit(0);
	});
}
