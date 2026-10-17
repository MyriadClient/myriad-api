/** Settings, from the environment (Coolify sets them per deployment). Every limit has a safe default. */
export interface Config {
	/** Port to listen on. */
	port: number;
	/** The SQLite file (on a persistent volume in production). */
	dbPath: string;
	/** The website, for links to a share's page. */
	siteUrl: string;
	/** Largest request body accepted, in bytes. */
	maxShareBytes: number;
	/** Shares one client may publish per hour, and per day. */
	uploadsPerHour: number;
	uploadsPerDay: number;
	/** Shares everyone together may publish per hour: a ceiling against floods from many addresses. */
	globalUploadsPerHour: number;
	/** Shares one client may fetch per minute, and how many of those may be codes that don't exist (guessing). */
	readsPerMinute: number;
	missesPerMinute: number;
	/** Delete attempts one client may make per hour. */
	deletesPerHour: number;
	/**
	 * How many proxies in front of the API append to X-Forwarded-For (Coolify's Traefik: 1). The client's address is
	 * the one the outermost of them saw; anything to its left was written by the client and is ignored. 0 uses the
	 * socket's address (no proxy).
	 */
	trustedProxies: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
	return {
		port: int(env.PORT, 3000),
		dbPath: env.DB_PATH ?? "data/myriad.db",
		siteUrl: (env.SITE_URL ?? "https://myriadclient.dev").replace(/\/$/, ""),
		maxShareBytes: int(env.MAX_SHARE_BYTES, 256 * 1024),
		uploadsPerHour: int(env.UPLOADS_PER_HOUR, 10),
		uploadsPerDay: int(env.UPLOADS_PER_DAY, 50),
		globalUploadsPerHour: int(env.GLOBAL_UPLOADS_PER_HOUR, 2000),
		readsPerMinute: int(env.READS_PER_MINUTE, 120),
		missesPerMinute: int(env.MISSES_PER_MINUTE, 20),
		deletesPerHour: int(env.DELETES_PER_HOUR, 30),
		trustedProxies: int(env.TRUSTED_PROXIES, 1, true),
	};
}

function int(value: string | undefined, fallback: number, zeroAllowed = false): number {
	const n = value === undefined ? NaN : Number.parseInt(value, 10);
	return Number.isFinite(n) && (n > 0 || (zeroAllowed && n === 0)) ? n : fallback;
}
