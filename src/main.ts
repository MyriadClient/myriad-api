import { serve } from "@hono/node-server";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { Store } from "./db.ts";
import { libraryConfigFromEnv } from "./library/config.ts";
import { RealGitHub } from "./library/github.ts";
import { createLibrary } from "./library/library.ts";

const config = configFromEnv();
const store = new Store(config.dbPath);
const libraryConfig = libraryConfigFromEnv();
const library = createLibrary(store.db, libraryConfig, libraryConfig.github && new RealGitHub(libraryConfig.github), config.trustedProxies);
library.start();
// A daily copy of the database next to it (dbPath's folder, /data on Coolify), the last seven kept.
if (config.dbPath !== ":memory:") {
	const backup = () => {
		try {
			store.backup(join(dirname(config.dbPath), "backups"), new Date());
		} catch (e) {
			console.error("backup failed", e);
		}
	};
	backup();
	setInterval(backup, 6 * 60 * 60 * 1000).unref();
}
const app = createApp(store, config, Date.now, library);

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
