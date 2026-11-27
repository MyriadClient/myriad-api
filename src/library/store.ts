import type { DatabaseSync } from "node:sqlite";
import type { KeyCert, Listing, Role, Sig, Source } from "./statements.ts";

/** A listing as stored: the signed fields, their signatures, and what's shown about it (unsigned). */
export interface ListingRow extends Listing {
	sigs: Sig[];
	name: string;
	description: string;
	author: string;
	repoName: string;
	/** Inspection findings the maintainer accepted for this listing: they don't hold up its next versions. */
	accepted: string[];
	/** The listing key's signatures over `accepted` (an `accepted` statement for this id and revision). */
	acceptedSigs: Sig[];
	paused: boolean;
	updatedAt: number;
}

export interface VersionRow {
	listingId: string;
	version: string;
	size: number;
	sha256: string;
	commit: string;
	url: string;
	minecraft: string | null;
	sigs: Sig[];
	developer: Sig[];
	createdAt: number;
	/** Display only, from the builder's report: what the version adds, and what changed in it. */
	modules?: ModuleInfo[];
	changelog?: string | null;
}

export interface ModuleInfo {
	name: string;
	description: string;
	tag: string;
}

export interface YankRow {
	listingId: string;
	version: string;
	sha256: string;
	sigs: Sig[];
}

export type SubmissionStatus = "waiting" | "queued" | "building" | "review" | "signed" | "rejected" | "failed";
export type Builder = "open" | "closed";

export interface SubmissionRow {
	id: number;
	repoId: number;
	tag: string;
	assetUrl: string | null;
	builder: Builder;
	status: SubmissionStatus;
	reason: string | null;
	report: unknown;
	checkRunId: number | null;
	headSha: string | null;
	dispatchedAt: number | null;
	tokenIssued: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface RepoRow {
	id: number;
	installationId: number;
	ownerId: number;
	fullName: string;
	private: boolean;
	removed: boolean;
}

export interface JobRow {
	id: number;
	kind: string;
	payload: unknown;
	attempts: number;
}

type Row = Record<string, unknown>;
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;

/** The Library's tables (see migrate.ts). Everything signed is stored as signed; nothing here is trusted by clients. */
export class LibraryStore {
	readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	transaction<T>(f: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const out = f();
			this.db.exec("COMMIT");
			return out;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	// ---- keys -------------------------------------------------------------------------------------------------------

	putCert(c: KeyCert, sigs: Sig[], now: number): void {
		this.db.prepare("INSERT INTO library_certs (key, role, not_after, sigs, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET role = excluded.role, not_after = excluded.not_after, sigs = excluded.sigs")
			.run(c.key, c.role, c.notAfter, json(sigs), now);
	}

	certs(): (KeyCert & { sigs: Sig[] })[] {
		return (this.db.prepare("SELECT key, role, not_after, sigs FROM library_certs ORDER BY key").all() as Row[])
			.map(r => ({ key: String(r.key), role: String(r.role) as Role, notAfter: Number(r.not_after), sigs: parse<Sig[]>(r.sigs) }));
	}

	putRevocations(seq: number, keys: string[], sigs: Sig[]): void {
		this.db.prepare("INSERT OR IGNORE INTO library_revocations (seq, keys, sigs) VALUES (?, ?, ?)").run(seq, json(keys), json(sigs));
	}

	latestRevocations(): { seq: number; keys: string[]; sigs: Sig[] } | undefined {
		const r = this.db.prepare("SELECT seq, keys, sigs FROM library_revocations ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
		return r && { seq: Number(r.seq), keys: parse<string[]>(r.keys), sigs: parse<Sig[]>(r.sigs) };
	}

	// ---- GitHub -----------------------------------------------------------------------------------------------------

	putInstallation(id: number, accountId: number, login: string, now: number): void {
		this.db.prepare("INSERT INTO library_installations (id, account_id, account_login, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_login = excluded.account_login, removed_at = NULL")
			.run(id, accountId, login, now);
	}

	removeInstallation(id: number, now: number): number[] {
		this.db.prepare("UPDATE library_installations SET removed_at = ? WHERE id = ?").run(now, id);
		const repos = (this.db.prepare("SELECT id FROM library_repos WHERE installation_id = ? AND removed_at IS NULL").all(id) as Row[]).map(r => Number(r.id));
		this.db.prepare("UPDATE library_repos SET removed_at = ? WHERE installation_id = ?").run(now, id);
		return repos;
	}

	/** Records a repository; true when it was known before under another owner (transferred). */
	putRepo(r: Omit<RepoRow, "removed">, now: number): boolean {
		const before = this.repo(r.id);
		this.db.prepare(`INSERT INTO library_repos (id, installation_id, owner_id, full_name, private, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET installation_id = excluded.installation_id, owner_id = excluded.owner_id, full_name = excluded.full_name,
			private = excluded.private, updated_at = excluded.updated_at, removed_at = NULL`)
			.run(r.id, r.installationId, r.ownerId, r.fullName, r.private ? 1 : 0, now);
		return before !== undefined && before.ownerId !== r.ownerId;
	}

	removeRepo(id: number, now: number): void {
		this.db.prepare("UPDATE library_repos SET removed_at = ? WHERE id = ?").run(now, id);
	}

	repo(id: number): RepoRow | undefined {
		const r = this.db.prepare("SELECT id, installation_id, owner_id, full_name, private, removed_at FROM library_repos WHERE id = ?").get(id) as Row | undefined;
		return r && { id: Number(r.id), installationId: Number(r.installation_id), ownerId: Number(r.owner_id), fullName: String(r.full_name), private: Number(r.private) === 1, removed: r.removed_at !== null };
	}

	/** Keeps the webhook delivery id; false when it was seen before (a replay). */
	firstDelivery(guid: string, now: number): boolean {
		const r = this.db.prepare("INSERT OR IGNORE INTO library_deliveries (guid, received_at) VALUES (?, ?)").run(guid, now);
		return Number(r.changes) === 1;
	}

	forgetDeliveries(before: number): void {
		this.db.prepare("DELETE FROM library_deliveries WHERE received_at < ?").run(before);
	}

	// ---- listings ---------------------------------------------------------------------------------------------------

	putListing(l: Omit<ListingRow, "paused" | "updatedAt">, now: number): void {
		this.db.prepare(`INSERT INTO library_listings (id, revision, repo_id, owner_id, source, download_repo_id, build, provides, keys, sigs, name, description, author, repo_name, accepted, accepted_sigs, paused, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
			ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, repo_id = excluded.repo_id, owner_id = excluded.owner_id, source = excluded.source,
			download_repo_id = excluded.download_repo_id, build = excluded.build, provides = excluded.provides, keys = excluded.keys, sigs = excluded.sigs,
			name = excluded.name, description = excluded.description, author = excluded.author, repo_name = excluded.repo_name, accepted = excluded.accepted,
			accepted_sigs = excluded.accepted_sigs, paused = 0, updated_at = excluded.updated_at`)
			.run(l.id, l.revision, l.repoId, l.ownerId, l.source, l.downloadRepoId, l.build, json(l.provides), json(l.keys), json(l.sigs),
				l.name, l.description, l.author, l.repoName, json(l.accepted), json(l.acceptedSigs), now);
	}

	listing(id: string): ListingRow | undefined {
		const r = this.db.prepare("SELECT * FROM library_listings WHERE id = ?").get(id) as Row | undefined;
		return r && listingOf(r);
	}

	listingForRepo(repoId: number): ListingRow | undefined {
		const r = this.db.prepare("SELECT * FROM library_listings WHERE repo_id = ? OR download_repo_id = ? ORDER BY id LIMIT 1").get(repoId, repoId) as Row | undefined;
		return r && listingOf(r);
	}

	listings(includePaused = false): ListingRow[] {
		return (this.db.prepare(`SELECT * FROM library_listings ${includePaused ? "" : "WHERE paused = 0"} ORDER BY id`).all() as Row[]).map(listingOf);
	}

	pauseListingsOf(repoId: number, now: number): number {
		return Number(this.db.prepare("UPDATE library_listings SET paused = 1, updated_at = ? WHERE (repo_id = ? OR download_repo_id = ?) AND paused = 0").run(now, repoId, repoId).changes);
	}

	setRepoName(repoId: number, name: string, now: number): void {
		this.db.prepare("UPDATE library_listings SET repo_name = ?, updated_at = ? WHERE repo_id = ?").run(name, now, repoId);
	}

	putIcon(listingId: string, png: Buffer): void {
		this.db.prepare("INSERT INTO library_icons (listing_id, png) VALUES (?, ?) ON CONFLICT(listing_id) DO UPDATE SET png = excluded.png").run(listingId, png);
	}

	icon(listingId: string): Buffer | undefined {
		const r = this.db.prepare("SELECT png FROM library_icons WHERE listing_id = ?").get(listingId) as { png: Uint8Array } | undefined;
		return r && Buffer.from(r.png);
	}

	// ---- versions ---------------------------------------------------------------------------------------------------

	/** Adds a version; false when that version is already listed (with any jar: one hash per version, ever). */
	addVersion(v: VersionRow): boolean {
		const r = this.db.prepare(`INSERT OR IGNORE INTO library_versions (listing_id, version, size, sha256, commit_sha, url, minecraft, sigs, developer, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(v.listingId, v.version, v.size, v.sha256, v.commit, v.url, v.minecraft, json(v.sigs), json(v.developer), v.createdAt);
		return Number(r.changes) === 1;
	}

	/** Sets what Browse shows of a version (its modules and changelog), already cleaned. */
	setVersionInfo(listingId: string, version: string, modules: ModuleInfo[], changelog: string | null): void {
		this.db.prepare("UPDATE library_versions SET modules = ?, changelog = ? WHERE listing_id = ? AND version = ?").run(json(modules), changelog, listingId, version);
	}

	version(listingId: string, version: string): VersionRow | undefined {
		const r = this.db.prepare("SELECT * FROM library_versions WHERE listing_id = ? AND version = ?").get(listingId, version) as Row | undefined;
		return r && versionOf(r);
	}

	/** The newest `limit` versions of a listing, by when they were added. */
	versions(listingId: string, limit = 10): VersionRow[] {
		return (this.db.prepare("SELECT * FROM library_versions WHERE listing_id = ? ORDER BY created_at DESC, version DESC LIMIT ?").all(listingId, limit) as Row[]).map(versionOf);
	}

	addYank(y: YankRow, now: number): void {
		this.db.prepare("INSERT OR IGNORE INTO library_yanks (listing_id, version, sha256, sigs, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(y.listingId, y.version, y.sha256, json(y.sigs), now);
	}

	yanks(listingId: string): YankRow[] {
		return (this.db.prepare("SELECT listing_id, version, sha256, sigs FROM library_yanks WHERE listing_id = ? ORDER BY created_at, version").all(listingId) as Row[])
			.map(r => ({ listingId: String(r.listing_id), version: String(r.version), sha256: String(r.sha256), sigs: parse<Sig[]>(r.sigs) }));
	}

	// ---- submissions ------------------------------------------------------------------------------------------------

	/** A new submission for `tag` of `repoId`; undefined when that release was submitted before. */
	addSubmission(repoId: number, tag: string, assetUrl: string | null, builder: Builder, status: SubmissionStatus, now: number): number | undefined {
		const r = this.db.prepare(`INSERT OR IGNORE INTO library_submissions (repo_id, tag, asset_url, builder, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(repoId, tag, assetUrl, builder, status, now, now);
		return Number(r.changes) === 1 ? Number(r.lastInsertRowid) : undefined;
	}

	submission(id: number): SubmissionRow | undefined {
		const r = this.db.prepare("SELECT * FROM library_submissions WHERE id = ?").get(id) as Row | undefined;
		return r && submissionOf(r);
	}

	submissions(statuses: SubmissionStatus[]): SubmissionRow[] {
		const marks = statuses.map(() => "?").join(",");
		return (this.db.prepare(`SELECT * FROM library_submissions WHERE status IN (${marks}) ORDER BY id`).all(...statuses) as Row[]).map(submissionOf);
	}

	updateSubmission(id: number, set: { status?: SubmissionStatus; reason?: string | null; report?: unknown; checkRunId?: number; headSha?: string; dispatchedAt?: number; tokenIssued?: boolean }, now: number): void {
		const cols: string[] = ["updated_at = ?"];
		const vals: (string | number | null)[] = [now];
		if (set.status !== undefined) { cols.push("status = ?"); vals.push(set.status); }
		if (set.reason !== undefined) { cols.push("reason = ?"); vals.push(set.reason); }
		if (set.report !== undefined) { cols.push("report = ?"); vals.push(json(set.report)); }
		if (set.checkRunId !== undefined) { cols.push("check_run_id = ?"); vals.push(set.checkRunId); }
		if (set.headSha !== undefined) { cols.push("head_sha = ?"); vals.push(set.headSha); }
		if (set.dispatchedAt !== undefined) { cols.push("dispatched_at = ?"); vals.push(set.dispatchedAt); }
		if (set.tokenIssued !== undefined) { cols.push("token_issued = ?"); vals.push(set.tokenIssued ? 1 : 0); }
		vals.push(id);
		this.db.prepare(`UPDATE library_submissions SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
	}

	/** Marks the source token as issued, only once: false when it was issued before. */
	claimSourceToken(id: number, now: number): boolean {
		return Number(this.db.prepare("UPDATE library_submissions SET token_issued = 1, updated_at = ? WHERE id = ? AND token_issued = 0").run(now, id).changes) === 1;
	}

	submissionsToday(installationId: number, since: number): number {
		const r = this.db.prepare(`SELECT COUNT(*) AS n FROM library_submissions s JOIN library_repos r ON r.id = s.repo_id WHERE r.installation_id = ? AND s.created_at >= ?`)
			.get(installationId, since) as { n: number };
		return Number(r.n);
	}

	// ---- jobs -------------------------------------------------------------------------------------------------------

	addJob(kind: string, payload: unknown, runAfter: number): void {
		this.db.prepare("INSERT INTO library_jobs (kind, payload, run_after) VALUES (?, ?, ?)").run(kind, json(payload), runAfter);
	}

	hasPendingJob(kind: string): boolean {
		return this.db.prepare("SELECT 1 FROM library_jobs WHERE done = 0 AND kind = ? LIMIT 1").get(kind) !== undefined;
	}

	/** Builds dispatched since `since` and not finished: all of them, or one installation's. */
	activeBuilds(since: number, installationId?: number): number {
		const r = (installationId === undefined
			? this.db.prepare("SELECT COUNT(*) AS n FROM library_submissions WHERE status IN ('queued', 'building') AND dispatched_at >= ?").get(since)
			: this.db.prepare(`SELECT COUNT(*) AS n FROM library_submissions s JOIN library_repos r ON r.id = s.repo_id
				WHERE s.status IN ('queued', 'building') AND s.dispatched_at >= ? AND r.installation_id = ?`).get(since, installationId)) as { n: number };
		return Number(r.n);
	}

	dueJobs(now: number, limit = 20): JobRow[] {
		return (this.db.prepare("SELECT id, kind, payload, attempts FROM library_jobs WHERE done = 0 AND run_after <= ? ORDER BY id LIMIT ?").all(now, limit) as Row[])
			.map(r => ({ id: Number(r.id), kind: String(r.kind), payload: parse(r.payload), attempts: Number(r.attempts) }));
	}

	finishJob(id: number): void {
		this.db.prepare("UPDATE library_jobs SET done = 1 WHERE id = ?").run(id);
	}

	retryJob(id: number, error: string, runAfter: number, giveUp: boolean): void {
		this.db.prepare("UPDATE library_jobs SET attempts = attempts + 1, error = ?, run_after = ?, done = ? WHERE id = ?").run(error.slice(0, 500), runAfter, giveUp ? 2 : 0, id);
	}

	// ---- snapshot ---------------------------------------------------------------------------------------------------

	putSnapshot(issued: number, text: string, etag: string): void {
		this.db.prepare("INSERT INTO library_snapshot (one, issued, text, etag) VALUES (1, ?, ?, ?) ON CONFLICT(one) DO UPDATE SET issued = excluded.issued, text = excluded.text, etag = excluded.etag")
			.run(issued, text, etag);
	}

	snapshot(): { issued: number; text: string; etag: string } | undefined {
		const r = this.db.prepare("SELECT issued, text, etag FROM library_snapshot WHERE one = 1").get() as Row | undefined;
		return r && { issued: Number(r.issued), text: String(r.text), etag: String(r.etag) };
	}
}

function listingOf(r: Row): ListingRow {
	return {
		id: String(r.id), revision: Number(r.revision), repoId: Number(r.repo_id), ownerId: Number(r.owner_id), source: String(r.source) as Source,
		downloadRepoId: Number(r.download_repo_id), build: String(r.build), provides: parse<string[]>(r.provides), keys: parse<string[]>(r.keys),
		sigs: parse<Sig[]>(r.sigs), name: String(r.name), description: String(r.description), author: String(r.author), repoName: String(r.repo_name),
		accepted: parse<string[]>(r.accepted), acceptedSigs: parse<Sig[]>(r.accepted_sigs), paused: Number(r.paused) === 1, updatedAt: Number(r.updated_at),
	};
}

function versionOf(r: Row): VersionRow {
	return {
		listingId: String(r.listing_id), version: String(r.version), size: Number(r.size), sha256: String(r.sha256), commit: String(r.commit_sha),
		url: String(r.url), minecraft: r.minecraft === null ? null : String(r.minecraft), sigs: parse<Sig[]>(r.sigs), developer: parse<Sig[]>(r.developer),
		createdAt: Number(r.created_at), modules: r.modules === undefined || r.modules === null ? [] : parse<ModuleInfo[]>(r.modules),
		changelog: r.changelog === undefined || r.changelog === null ? null : String(r.changelog),
	};
}

function submissionOf(r: Row): SubmissionRow {
	return {
		id: Number(r.id), repoId: Number(r.repo_id), tag: String(r.tag), assetUrl: r.asset_url === null ? null : String(r.asset_url),
		builder: String(r.builder) as Builder, status: String(r.status) as SubmissionStatus, reason: r.reason === null ? null : String(r.reason),
		report: r.report === null ? null : parse(r.report), checkRunId: r.check_run_id === null ? null : Number(r.check_run_id),
		headSha: r.head_sha === null ? null : String(r.head_sha), dispatchedAt: r.dispatched_at === null ? null : Number(r.dispatched_at),
		tokenIssued: Number(r.token_issued) === 1, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
	};
}
