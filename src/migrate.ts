import type { DatabaseSync } from "node:sqlite";

/**
 * The database's shape, one step per version, kept in `PRAGMA user_version`. Steps only ever add: a database made by
 * an older API is brought up to date on open, and nothing in it is lost. A database newer than this API refuses to open.
 */
const STEPS: string[] = [
	// 1: shared configs (databases from before migrations already have this table, with user_version 0).
	`CREATE TABLE IF NOT EXISTS shares (
		code        TEXT PRIMARY KEY,
		document    TEXT NOT NULL,
		delete_hash TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		views       INTEGER NOT NULL DEFAULT 0
	)`,
	// 2: the Myriad Library.
	`CREATE TABLE library_certs (
		key       TEXT PRIMARY KEY,
		role      TEXT NOT NULL,
		not_after INTEGER NOT NULL,
		sigs      TEXT NOT NULL,
		added_at  INTEGER NOT NULL
	);
	CREATE TABLE library_revocations (
		seq  INTEGER PRIMARY KEY,
		keys TEXT NOT NULL,
		sigs TEXT NOT NULL
	);
	CREATE TABLE library_installations (
		id            INTEGER PRIMARY KEY,
		account_id    INTEGER NOT NULL,
		account_login TEXT NOT NULL,
		created_at    INTEGER NOT NULL,
		removed_at    INTEGER
	);
	CREATE TABLE library_repos (
		id              INTEGER PRIMARY KEY,
		installation_id INTEGER NOT NULL,
		owner_id        INTEGER NOT NULL,
		full_name       TEXT NOT NULL,
		private         INTEGER NOT NULL,
		updated_at      INTEGER NOT NULL,
		removed_at      INTEGER
	);
	CREATE TABLE library_listings (
		id               TEXT PRIMARY KEY,
		revision         INTEGER NOT NULL,
		repo_id          INTEGER NOT NULL,
		owner_id         INTEGER NOT NULL,
		source           TEXT NOT NULL,
		download_repo_id INTEGER NOT NULL,
		build            TEXT NOT NULL,
		provides         TEXT NOT NULL,
		keys             TEXT NOT NULL,
		sigs             TEXT NOT NULL,
		name             TEXT NOT NULL,
		description      TEXT NOT NULL,
		author           TEXT NOT NULL,
		repo_name        TEXT NOT NULL,
		accepted         TEXT NOT NULL DEFAULT '[]',
		paused           INTEGER NOT NULL DEFAULT 0,
		updated_at       INTEGER NOT NULL
	);
	CREATE TABLE library_versions (
		listing_id TEXT NOT NULL,
		version    TEXT NOT NULL,
		size       INTEGER NOT NULL,
		sha256     TEXT NOT NULL,
		commit_sha TEXT NOT NULL,
		url        TEXT NOT NULL,
		minecraft  TEXT,
		sigs       TEXT NOT NULL,
		developer  TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (listing_id, version)
	);
	CREATE TABLE library_yanks (
		listing_id TEXT NOT NULL,
		version    TEXT NOT NULL,
		sha256     TEXT NOT NULL,
		sigs       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (listing_id, version, sha256)
	);
	CREATE TABLE library_icons (
		listing_id TEXT PRIMARY KEY,
		png        BLOB NOT NULL
	);
	CREATE TABLE library_submissions (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		repo_id       INTEGER NOT NULL,
		tag           TEXT NOT NULL,
		asset_url     TEXT,
		builder       TEXT NOT NULL,
		status        TEXT NOT NULL,
		reason        TEXT,
		report        TEXT,
		check_run_id  INTEGER,
		head_sha      TEXT,
		dispatched_at INTEGER,
		token_issued  INTEGER NOT NULL DEFAULT 0,
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL,
		UNIQUE (repo_id, tag)
	);
	CREATE TABLE library_deliveries (
		guid        TEXT PRIMARY KEY,
		received_at INTEGER NOT NULL
	);
	CREATE TABLE library_jobs (
		id        INTEGER PRIMARY KEY AUTOINCREMENT,
		kind      TEXT NOT NULL,
		payload   TEXT NOT NULL,
		attempts  INTEGER NOT NULL DEFAULT 0,
		run_after INTEGER NOT NULL,
		done      INTEGER NOT NULL DEFAULT 0,
		error     TEXT
	);
	CREATE TABLE library_snapshot (
		one    INTEGER PRIMARY KEY CHECK (one = 1),
		issued INTEGER NOT NULL,
		text   TEXT NOT NULL,
		etag   TEXT NOT NULL
	)`,
	// 3: the listing key's signature over each listing's accepted findings (the builder trusts only signed ones).
	`ALTER TABLE library_listings ADD COLUMN accepted_sigs TEXT NOT NULL DEFAULT '[]'`,
	// 4: what Browse shows of each version before it's installed: its modules and its changelog, from the builder's report.
	`ALTER TABLE library_versions ADD COLUMN modules TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE library_versions ADD COLUMN changelog TEXT`,
	// 5: invite-only listings (their jars from a private releases repository, handed out only to accounts with a grant),
	// the release asset each version is, and players' accounts: linked Minecraft sessions, invites and grants.
	`ALTER TABLE library_listings ADD COLUMN access TEXT NOT NULL DEFAULT 'public';
	ALTER TABLE library_submissions ADD COLUMN asset_id INTEGER;
	ALTER TABLE library_versions ADD COLUMN asset_id INTEGER;
	CREATE TABLE auth_nonces (
		nonce_hash TEXT PRIMARY KEY,
		created    INTEGER NOT NULL
	);
	CREATE TABLE auth_sessions (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		token_hash TEXT NOT NULL UNIQUE,
		uuid       TEXT NOT NULL,
		name       TEXT NOT NULL,
		label      TEXT NOT NULL,
		created    INTEGER NOT NULL,
		last_used  INTEGER NOT NULL,
		expires    INTEGER NOT NULL
	);
	CREATE INDEX auth_sessions_uuid ON auth_sessions (uuid);
	CREATE TABLE library_invites (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		listing_id TEXT NOT NULL,
		code_hash  TEXT NOT NULL UNIQUE,
		max_uses   INTEGER NOT NULL,
		uses_left  INTEGER NOT NULL,
		expires    INTEGER NOT NULL,
		label      TEXT NOT NULL DEFAULT '',
		created    INTEGER NOT NULL,
		revoked    INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE library_grants (
		listing_id TEXT NOT NULL,
		uuid       TEXT NOT NULL,
		name       TEXT NOT NULL,
		invite_id  INTEGER,
		created    INTEGER NOT NULL,
		revoked    INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (listing_id, uuid)
	);
	CREATE TABLE library_requests (
		nonce TEXT PRIMARY KEY,
		seen  INTEGER NOT NULL
	);
	CREATE TABLE library_downloads (
		listing_id TEXT NOT NULL,
		uuid       TEXT NOT NULL,
		version    TEXT NOT NULL,
		at         INTEGER NOT NULL
	);
	CREATE INDEX library_downloads_who ON library_downloads (listing_id, uuid, at)`,
	// 6: what an invite-only listing shows everyone beyond its modules (its developer's choice): changelog, repo.
	`ALTER TABLE library_listings ADD COLUMN shows TEXT NOT NULL DEFAULT '[]'`,
	// 7: the API keeps no key to developers' repositories. Check runs wait here for the private builder to post them;
	// invite-only jars are uploaded by the maintainer with the signed version and served from here.
	`ALTER TABLE library_submissions ADD COLUMN check_pending TEXT;
	ALTER TABLE library_submissions ADD COLUMN check_seq INTEGER NOT NULL DEFAULT 0;
	CREATE TABLE library_jars (
		listing_id TEXT NOT NULL,
		version    TEXT NOT NULL,
		sha256     TEXT NOT NULL,
		data       BLOB NOT NULL,
		added      INTEGER NOT NULL,
		PRIMARY KEY (listing_id, version)
	)`,
];

export const SCHEMA_VERSION = STEPS.length;

export function migrate(db: DatabaseSync): void {
	const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
	if (current > STEPS.length) throw new Error(`the database is version ${current}, newer than this API (${STEPS.length})`);
	for (let v = current; v < STEPS.length; v++) {
		db.exec("BEGIN");
		try {
			db.exec(STEPS[v]!);
			db.exec(`PRAGMA user_version = ${v + 1}`);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	}
}
