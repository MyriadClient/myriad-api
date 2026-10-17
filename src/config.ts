/** Settings, from the environment (Coolify sets them per deployment). */
export interface Config {
	/** Port to listen on. */
	port: number;
	/** The SQLite file (on a persistent volume in production). */
	dbPath: string;
	/** The website, for links to a share's page. */
	siteUrl: string;
	/** Largest share accepted, in bytes. */
	maxShareBytes: number;
	/** Shares one address may publish per hour, and per day. */
	uploadsPerHour: number;
	uploadsPerDay: number;
	/** Whether to take the client's address from X-Forwarded-For (behind Coolify's proxy). */
	trustProxy: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
	return {
		port: int(env.PORT, 3000),
		dbPath: env.DB_PATH ?? "data/myriad.db",
		siteUrl: (env.SITE_URL ?? "https://myriadclient.dev").replace(/\/$/, ""),
		maxShareBytes: int(env.MAX_SHARE_BYTES, 256 * 1024),
		uploadsPerHour: int(env.UPLOADS_PER_HOUR, 10),
		uploadsPerDay: int(env.UPLOADS_PER_DAY, 50),
		trustProxy: env.TRUST_PROXY !== "false",
	};
}

function int(value: string | undefined, fallback: number): number {
	const n = value === undefined ? NaN : Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
