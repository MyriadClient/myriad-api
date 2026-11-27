import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DatabaseSync } from "node:sqlite";
import { clientKey } from "../address.ts";
import { keyMatches } from "../codes.ts";
import { RateLimit } from "../rateLimit.ts";
import type { LibraryConfig } from "./config.ts";
import { type CheckRun, checkBody, type GitHub, webhookSignatureValid } from "./github.ts";
import {
	acceptCert, acceptListing, acceptRevocations, acceptVersion, acceptYank, buildSnapshot, checkId, detailsText, downloadable, listingLive, Refused, shown, showsAll, versionInfo,
} from "./rules.ts";
import { accountRoutes, type Mojang, realMojang } from "./accounts.ts";
import { approvedCheck, buildingCheck, listedCheck, queuedCheck, refusedCheck, reviewCheck } from "./checks.ts";
import { InvalidStatement, MAX_JAR, privateKey, sha256Hex } from "./statements.ts";
import { type Builder, LibraryStore, type ListingRow, type SubmissionRow } from "./store.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TAG = /^[A-Za-z0-9._+-]{1,100}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const TOKEN = /^Bearer ([A-Za-z0-9_-]{20,128})$/;
const MAX_ICON = 64 * 1024;
/** Builds running at once: all together, and for one installation, so one account can't hold every builder. */
const MAX_BUILDS = 6;
const MAX_BUILDS_EACH = 2;

/** A dispatch that waits for a free builder. */
class Busy extends Error {}

export interface Library {
	app: Hono;
	/** Runs the jobs that are due (also every 30 seconds once started). */
	tick(): Promise<void>;
	/** Starts the timers: jobs, the hourly index, forgetting old webhook deliveries. */
	start(): void;
	store: LibraryStore;
}

/**
 * The Myriad Library's routes. GitHub tells the API about releases through the Library GitHub App's webhooks; a
 * builder (GitHub Actions in MyriadClient's builder repositories) builds and checks each release and reports back; the
 * maintainer approves what needs a person, with documents signed by the listing key. The API signs only the index
 * (which listings and versions are current), never a listing or version: those are signed elsewhere, and the API
 * accepts them only if the right key did.
 *
 * Public: `GET /v1/index.json` (signed index, with ETag), `GET /v1/library/addons[/:id[/icon.png]]`.
 * GitHub: `POST /v1/github/webhook`.
 * Builders (their own token): `GET /v1/library/builds/:id`, `POST .../started`, `.../result`; the private builder also
 * `GET /v1/library/checks` and `POST /v1/library/checks/:id` (it posts every check run: the API holds no repo key).
 * Maintainer (admin token): `GET /v1/library/pending`, `POST /v1/library/submissions/:id/accept|reject`,
 * `POST /v1/library/approvals` (signed listings, versions, yanks, certificates), `POST /v1/library/listings/:id/pause`,
 * `PUT /v1/library/jars/:id/:version` (an invite-only release's jar, kept only if a signed version names it).
 */
export function createLibrary(db: DatabaseSync, config: LibraryConfig, github: GitHub | undefined, trustedProxies: number, now: () => number = Date.now,
	mojang: Mojang = realMojang): Library {
	const lib = new LibraryStore(db);
	const indexKey = config.indexKey ? privateKey(config.indexKey) : undefined;
	const app = new Hono();
	const reads = new RateLimit(120, MINUTE);
	const writes = new RateLimit(60, MINUTE);
	const who = (c: Context) => clientKey(c.req.header("x-forwarded-for"), socketAddress(c), trustedProxies, c.req.header("cf-connecting-ip"));

	// Each rebuild moves `issued` on by at least a second. However many changes arrive, it never gets more than a minute
	// ahead of the clock (clients refuse an index from more than a day ahead): past that, rebuilds wait.
	let later: ReturnType<typeof setTimeout> | undefined;
	const rebuild = () => {
		if (!indexKey) return;
		const last = lib.snapshot();
		if (last && last.issued >= Math.floor(now() / 1000) + 60) {
			later ??= setTimeout(() => {
				later = undefined;
				rebuild();
			}, 1000);
			later.unref?.();
			return;
		}
		buildSnapshot(lib, indexKey, now());
	};
	const deploySoon = () => {
		if (!config.deployHook || lib.hasPendingJob("deploy")) return;
		lib.addJob("deploy", {}, now() + 10 * MINUTE);
	};
	const changed = () => {
		rebuild();
		deploySoon();
	};
	/** A submission's check run changes: kept here and posted by the private builder (one workflow run for all waiting). */
	const check = (submission: number, run: CheckRun) => {
		lib.setPendingCheck(submission, run, now());
		if (!lib.hasPendingJob("checks")) lib.addJob("checks", {}, now());
	};

	// ---- public ---------------------------------------------------------------------------------------------------

	app.get("/v1/index.json", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		let snap = lib.snapshot();
		if (!snap && indexKey) snap = buildSnapshot(lib, indexKey, now());
		if (!snap) return c.json({ error: "The Library isn't open yet" }, 503);
		c.header("ETag", snap.etag);
		c.header("Cache-Control", "public, max-age=300");
		const asked = (c.req.header("if-none-match") ?? "").split(",").map(t => t.trim().replace(/^W\//, ""));
		if (asked.includes(snap.etag)) return c.body(null, 304);
		return c.body(snap.text, 200, { "Content-Type": "application/json; charset=utf-8" });
	});

	app.get("/v1/library/addons", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		// The website's build reads a 404 here as "not open yet".
		if (!indexKey && !lib.snapshot()) return c.json({ error: "The Library isn't open yet" }, 404);
		c.header("Cache-Control", "public, max-age=300");
		return c.json(lib.listings().filter(l => listingLive(lib, l)).map(l => summary(lib, l)));
	});

	app.get("/v1/library/addons/:id", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		const l = lib.listing(c.req.param("id"));
		if (!l || !listingLive(lib, l)) return c.json({ error: "No such addon" }, 404);
		const yanked = new Set(lib.yanks(l.id).map(y => `${y.version}/${y.sha256}`));
		c.header("Cache-Control", "public, max-age=300");
		return c.json({
			...summary(lib, l),
			versions: lib.versions(l.id).map(v => ({
				version: v.version, minecraft: v.minecraft, sha256: v.sha256, size: v.size, ...(l.access === "invite" ? {} : { url: v.url }), commit: v.commit,
				added: new Date(v.createdAt).toISOString(), yanked: yanked.has(`${v.version}/${v.sha256}`),
			})),
		});
	});

	app.get("/v1/library/addons/:id/details.json", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		const l = lib.listing(c.req.param("id"));
		const text = l && listingLive(lib, l) ? detailsText(lib, l) : undefined;
		if (!text) return c.json({ error: "No details" }, 404);
		return c.body(text, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" });
	});

	app.get("/v1/library/addons/:id/icon.png", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		const l = lib.listing(c.req.param("id"));
		const png = l && listingLive(lib, l) ? lib.icon(l.id) : undefined;
		if (!png) return c.json({ error: "No icon" }, 404);
		return c.body(new Uint8Array(png), 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
	});

	// ---- GitHub ---------------------------------------------------------------------------------------------------

	app.post("/v1/github/webhook", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "Too big" }, 413) }), async c => {
		if (!config.webhookSecret) return c.json({ error: "Not found" }, 404);
		const body = Buffer.from(await c.req.arrayBuffer());
		if (!webhookSignatureValid(config.webhookSecret, body, c.req.header("x-hub-signature-256"))) return c.json({ error: "Bad signature" }, 401);
		const guid = c.req.header("x-github-delivery") ?? "";
		if (!/^[0-9a-f-]{8,64}$/i.test(guid)) return c.json({ error: "No delivery id" }, 400);
		let payload: Record<string, any>;
		try {
			payload = JSON.parse(body.toString("utf8"));
		} catch {
			return c.json({ error: "Not JSON" }, 400);
		}
		// The delivery is recorded with what it did, so one that fails can be redelivered.
		const first = lib.transaction(() => {
			if (!lib.firstDelivery(guid, now())) return false;
			onEvent(c.req.header("x-github-event") ?? "", payload);
			return true;
		});
		return first ? c.json({ ok: true }, 202) : c.json({ ok: true, seen: true });
	});

	function onEvent(event: string, p: Record<string, any>): void {
		const t = now();
		const installation = Number(p.installation?.id);
		if (event === "installation") {
			const account = p.installation?.account;
			if (["created", "new_permissions_accepted", "unsuspend"].includes(p.action) && Number.isSafeInteger(installation) && account) {
				lib.putInstallation(installation, Number(account.id), String(account.login ?? "").slice(0, 100), t);
				for (const r of Array.isArray(p.repositories) ? p.repositories.slice(0, 1000) : []) addRepo(r, installation, Number(account.id), t);
			} else if (["deleted", "suspend"].includes(p.action) && Number.isSafeInteger(installation)) {
				for (const repo of lib.removeInstallation(installation, t)) pause(repo);
			}
		} else if (event === "installation_repositories" && Number.isSafeInteger(installation)) {
			const owner = Number(p.installation?.account?.id);
			for (const r of Array.isArray(p.repositories_added) ? p.repositories_added.slice(0, 1000) : []) addRepo(r, installation, owner, t);
			for (const r of Array.isArray(p.repositories_removed) ? p.repositories_removed.slice(0, 1000) : []) {
				lib.removeRepo(Number(r.id), t);
				pause(Number(r.id));
			}
		} else if (event === "repository") {
			const r = p.repository;
			const id = Number(r?.id);
			if (!lib.repo(id)) return;
			if (p.action === "renamed" && REPO.test(String(r.full_name))) {
				addRepo(r, installation, Number(r.owner?.id), t);
				lib.setRepoName(id, String(r.full_name), t);
				if (lib.listingForRepo(id)) changed();
			} else if (["transferred", "privatized", "publicized", "deleted"].includes(p.action)) {
				// Publicized pauses too: an invite-only listing's private releases repository made public is no longer what
				// was approved (its jars are anyone's now), and a closed listing's source going public wants a fresh look.
				if (p.action === "deleted") lib.removeRepo(id, t);
				else addRepo(r, installation, Number(r.owner?.id), t);
				pause(id);
			}
		} else if (event === "release" && p.action === "published") {
			release(p, installation, t);
		}
	}

	function addRepo(r: any, installation: number, ownerId: number, t: number): void {
		const id = Number(r?.id);
		const owner = Number(r?.owner?.id ?? ownerId);
		if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(owner) || owner <= 0 || !REPO.test(String(r?.full_name))) return;
		if (lib.putRepo({ id, installationId: installation, ownerId: owner, fullName: String(r.full_name), private: r.private === true }, t)) pause(id);
	}

	function pause(repoId: number): void {
		if (lib.pauseListingsOf(repoId, now()) > 0) changed();
	}

	/**
	 * A published release. Of a public repository: built by the open builder (a new addon, or an update to a listed
	 * open-source one). Of a closed-source listing's public releases repository: built by the private builder, for review.
	 * Of a private repository not yet listed: waits for the maintainer to accept it before anything is built.
	 */
	function release(p: Record<string, any>, installation: number, t: number): void {
		const rel = p.release;
		const r = p.repository;
		const repoId = Number(r?.id);
		const repo = lib.repo(repoId);
		if (!repo || repo.removed || repo.installationId !== installation) return;
		if (rel?.draft || rel?.prerelease || !TAG.test(String(rel?.tag_name))) return;
		if (lib.submissionsToday(installation, t - 24 * HOUR) >= config.submissionsPerDay) return;
		const listing = lib.listingForRepo(repoId);
		if (listing && !listingLive(lib, listing)) return; // paused, or no longer its approved owner's
		let builder: Builder, status: SubmissionRow["status"];
		if (listing?.source === "closed") {
			if (listing.downloadRepoId !== repoId) return; // its jars come from its public releases repository
			builder = "closed";
			status = "queued";
		} else if (r.private === true) {
			builder = "closed";
			status = "waiting";
		} else {
			builder = "open";
			status = "queued";
		}
		// The jar: its address (checked against the signed version later) and its asset id (to fetch it from a private
		// releases repository, for an invite-only listing).
		const chosen = (Array.isArray(rel.assets) ? rel.assets : [])
			.find((a: any) => downloadable(String(a?.browser_download_url ?? "")) && !/-(sources|javadoc)\.jar$/.test(String(a?.browser_download_url)));
		const asset = chosen ? String(chosen.browser_download_url) : undefined;
		const assetId = chosen && Number.isSafeInteger(chosen.id) && chosen.id > 0 ? Number(chosen.id) : null;
		const id = lib.addSubmission(repoId, String(rel.tag_name), asset ?? null, builder, status, t, assetId);
		if (id === undefined) return;
		check(id, queuedCheck(String(rel.tag_name), builder === "closed", status === "waiting"));
		if (status === "queued") lib.addJob("dispatch", { submission: id }, t);
	}

	// ---- builders -------------------------------------------------------------------------------------------------

	const builderOf = (c: Context): Builder | undefined => {
		const token = TOKEN.exec(c.req.header("authorization") ?? "")?.[1];
		if (!token) return undefined;
		if (config.builderOpenTokenSha256 && keyMatches(token, config.builderOpenTokenSha256)) return "open";
		if (config.builderClosedTokenSha256 && keyMatches(token, config.builderClosedTokenSha256)) return "closed";
		return undefined;
	};

	/** The submission a builder may act on: its own kind, still being built, and dispatched in the last six hours. */
	const buildFor = (c: Context): { sub: SubmissionRow; builder: Builder } | Response => {
		if (!writes.tryHit(who(c), now())) return tooMany(c);
		const builder = builderOf(c);
		if (!builder) return c.json({ error: "Not allowed" }, 403);
		const sub = lib.submission(Number(c.req.param("id")));
		if (!sub || sub.builder !== builder || !["queued", "building"].includes(sub.status)) return c.json({ error: "No such build" }, 404);
		if (!sub.dispatchedAt || now() - sub.dispatchedAt > 6 * HOUR) return c.json({ error: "That build has run out of time" }, 410);
		return { sub, builder };
	};

	app.get("/v1/library/builds/:id", c => {
		const b = buildFor(c);
		if (b instanceof Response) return b;
		const repo = lib.repo(b.sub.repoId)!;
		const listing = lib.listingForRepo(b.sub.repoId);
		const source = listing?.source === "closed" ? lib.repo(listing.repoId) : repo;
		return c.json({
			id: b.sub.id, builder: b.builder, tag: b.sub.tag, assetUrl: b.sub.assetUrl,
			repo: { id: repo.id, fullName: repo.fullName, ownerId: repo.ownerId, private: repo.private },
			source: source ? { id: source.id, fullName: source.fullName, ownerId: source.ownerId, private: source.private } : null,
			listing: listing ? signedListing(listing) : null,
			accepted: listing?.accepted ?? [],
			acceptedSignatures: listing?.acceptedSigs ?? [],
		});
	});

	app.post("/v1/library/builds/:id/started", c => {
		const b = buildFor(c);
		if (b instanceof Response) return b;
		lib.updateSubmission(b.sub.id, { status: "building" }, now());
		check(b.sub.id, buildingCheck(b.sub.tag, b.builder === "closed"));
		return c.json({ ok: true });
	});

	// ---- check runs, posted by the private builder (which holds the Library App's key) ---------------------------------

	const closedBuilder = (c: Context): Response | undefined => {
		if (!writes.tryHit(who(c), now())) return tooMany(c);
		return builderOf(c) === "closed" ? undefined : c.json({ error: "Not allowed" }, 403);
	};

	/** What check runs to post: for each, the repository and tag, the run already made (if any) and what it should say. */
	app.get("/v1/library/checks", c => {
		const no = closedBuilder(c);
		if (no) return no;
		return c.json(lib.pendingChecks(50).flatMap(p => {
			const repo = lib.repo(p.submission.repoId);
			if (!repo || repo.removed) return [];
			return [{
				submission: p.submission.id, seq: p.seq, repo: { id: repo.id, fullName: repo.fullName, ownerId: repo.ownerId }, tag: p.submission.tag,
				headSha: p.submission.headSha, checkRunId: p.submission.checkRunId, run: checkBody(p.run as CheckRun),
			}];
		}));
	});

	/** The builder posted a check run: its id and commit, so later changes update the same run. */
	app.post("/v1/library/checks/:id", async c => {
		const no = closedBuilder(c);
		if (no) return no;
		const body = await jsonBody(c);
		const seq = Number(body?.seq), runId = Number(body?.checkRunId), head = String(body?.headSha ?? "");
		if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(runId) || runId <= 0 || !/^[0-9a-f]{40}$/.test(head)) return c.json({ error: "Not a posted check run" }, 400);
		return lib.checkPosted(Number(c.req.param("id")), seq, runId, head, now()) ? c.json({ ok: true }) : c.json({ error: "No such check run" }, 404);
	});

	app.post("/v1/library/builds/:id/result", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "Too big" }, 413) }), async c => {
		const b = buildFor(c);
		if (b instanceof Response) return b;
		const body = await jsonBody(c);
		if (!body) return c.json({ error: "Not JSON" }, 400);
		const t = now();
		const report = body.report && typeof body.report === "object" ? body.report : {};
		const icon = iconOf(body.icon);
		if (JSON.stringify(report).length > 768 * 1024) return c.json({ error: "Report too big" }, 413);
		const stored = { ...report, ...(icon ? { icon: icon.toString("base64") } : {}) };
		if (body.outcome === "signed") {
			if (b.builder !== "open") return c.json({ error: "Not allowed" }, 403);
			try {
				const own = lib.listingForRepo(b.sub.repoId);
				if (!own || body.version?.id !== own.id) throw new Refused("the version isn't this repository's listing");
				if (body.version?.url !== b.sub.assetUrl) throw new Refused("the version isn't this release's jar");
				const added = lib.transaction(() => {
					const r = acceptVersion(lib, config.rootKeys, body.version, t);
					lib.setVersionAsset(own.id, String(body.version.version), b.sub.assetId);
					const shownInfo = versionInfo(report);
					lib.setVersionInfo(own.id, String(body.version.version), shownInfo.modules, shownInfo.changelog);
					return r;
				});
				if (icon && added.added) lib.putIcon(own.id, icon);
				lib.updateSubmission(b.sub.id, { status: "signed", reason: null, report: stored }, t);
				check(b.sub.id, listedCheck(b.sub.tag, own.id, shown(body.version?.version, 64), stored, (b.builder === "open" ? runOf(report) : undefined)));
				if (added.added) changed();
				return c.json({ ok: true });
			} catch (e) {
				const why = e instanceof Refused || e instanceof InvalidStatement ? e.message : "it couldn't be checked";
				lib.updateSubmission(b.sub.id, { status: "failed", reason: `Refused: ${why}`, report: stored }, t);
				check(b.sub.id, refusedCheck(b.sub.tag, `Refused: ${why}`, stored, "listed", (b.builder === "open" ? runOf(report) : undefined)));
				return c.json({ error: why }, 422);
			}
		}
		if (body.outcome === "review") {
			lib.updateSubmission(b.sub.id, { status: "review", reason: shown(body.reason, 500) || null, report: stored }, t);
			check(b.sub.id, reviewCheck(b.sub.tag, shown(body.reason, 2000), stored, (b.builder === "open" ? runOf(report) : undefined)));
			return c.json({ ok: true });
		}
		const reason = shown(body.reason, 500) || "The build failed.";
		lib.updateSubmission(b.sub.id, { status: "failed", reason, report: stored }, t);
		check(b.sub.id, refusedCheck(b.sub.tag, reason, stored, Object.keys(report).length ? "checks" : "build", (b.builder === "open" ? runOf(report) : undefined)));
		return c.json({ ok: true });
	});

	// ---- maintainer -----------------------------------------------------------------------------------------------

	const admin = (c: Context): boolean => {
		const token = TOKEN.exec(c.req.header("authorization") ?? "")?.[1];
		return !!token && !!config.adminTokenSha256 && keyMatches(token, config.adminTokenSha256);
	};
	const adminOnly = (c: Context): Response | undefined => {
		if (!writes.tryHit(who(c), now())) return tooMany(c);
		return admin(c) ? undefined : c.json({ error: "Not allowed" }, 403);
	};

	app.get("/v1/library/pending", c => {
		const no = adminOnly(c);
		if (no) return no;
		return c.json(lib.submissions(["waiting", "queued", "building", "review", "failed"]).map(s => ({
			id: s.id, status: s.status, builder: s.builder, tag: s.tag, reason: s.reason, assetUrl: s.assetUrl,
			repo: lib.repo(s.repoId)?.fullName ?? null, repoId: s.repoId, ownerId: lib.repo(s.repoId)?.ownerId ?? null,
			listing: lib.listingForRepo(s.repoId)?.id ?? null, report: s.report, created: new Date(s.createdAt).toISOString(),
		})));
	});

	/**
	 * An invite-only release's jar, from the maintainer's review tool (which took it from the builder's run and signed
	 * the version): kept only when it's exactly the jar a signed version names. Players download it from here.
	 */
	app.put("/v1/library/jars/:id/:version", bodyLimit({ maxSize: MAX_JAR, onError: c => c.json({ error: "Too big" }, 413) }), async c => {
		const no = adminOnly(c);
		if (no) return no;
		const l = lib.listing(c.req.param("id"));
		const v = l && lib.version(l.id, c.req.param("version"));
		if (!l || l.access !== "invite" || !v) return c.json({ error: "No signed invite-only version with that id" }, 404);
		const jar = Buffer.from(await c.req.arrayBuffer());
		if (jar.length !== v.size || sha256Hex(jar) !== v.sha256) return c.json({ error: "That isn't the jar the signed version names" }, 422);
		lib.putJar(l.id, v.version, v.sha256, jar, now());
		return c.json({ ok: true });
	});

	app.post("/v1/library/submissions/:id/accept", c => {
		const no = adminOnly(c);
		if (no) return no;
		const sub = lib.submission(Number(c.req.param("id")));
		if (!sub || sub.status !== "waiting") return c.json({ error: "Nothing waiting with that id" }, 404);
		lib.updateSubmission(sub.id, { status: "queued" }, now());
		lib.addJob("dispatch", { submission: sub.id }, now());
		check(sub.id, queuedCheck(sub.tag, true, false));
		return c.json({ ok: true });
	});

	app.post("/v1/library/submissions/:id/reject", async c => {
		const no = adminOnly(c);
		if (no) return no;
		const body = await jsonBody(c);
		const sub = lib.submission(Number(c.req.param("id")));
		if (!sub || ["signed", "rejected"].includes(sub.status)) return c.json({ error: "No open submission with that id" }, 404);
		const reason = shown(body?.reason, 500) || "Not accepted into the Myriad Library.";
		lib.updateSubmission(sub.id, { status: "rejected", reason }, now());
		check(sub.id, refusedCheck(sub.tag, reason, sub.report as Record<string, unknown> | null, "review"));
		return c.json({ ok: true });
	});

	/**
	 * Signed documents from the maintainer's review tool: key certificates and revocations (root-signed), listings and
	 * closed-source versions (listing key), yanks. The signature decides; the admin token only keeps this route private.
	 */
	app.post("/v1/library/approvals", bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: "Too big" }, 413) }), async c => {
		const no = adminOnly(c);
		if (no) return no;
		const body = await jsonBody(c);
		if (!body) return c.json({ error: "Not JSON" }, 400);
		const t = now();
		const sub = body.submission === undefined ? undefined : lib.submission(Number(body.submission));
		try {
			lib.transaction(() => {
				switch (body.kind) {
					case "cert": acceptCert(lib, config.rootKeys, body.doc, t); break;
					case "revocations": acceptRevocations(lib, config.rootKeys, body.doc); break;
					case "listing": {
						const repo = lib.repo(Number(body.doc?.repoId));
						const ours = repo?.ownerId === config.myriadOwnerId && config.myriadOwnerId > 0;
						checkId(body.doc?.id, ours);
						for (const p of Array.isArray(body.doc?.provides) ? body.doc.provides : []) checkId(p, ours);
						const l = acceptListing(lib, config.rootKeys, body.doc, t);
						const icon = sub && typeof (sub.report as any)?.icon === "string" ? iconOf((sub.report as any).icon) : undefined;
						if (icon) lib.putIcon(l.id, icon);
						break;
					}
					case "version": {
						acceptVersion(lib, config.rootKeys, body.doc, t);
						if (sub) lib.setVersionAsset(String(body.doc.id), String(body.doc.version), sub.assetId);
						// A reviewed version shows what its build's report said, and refreshes the listing's icon.
						if (sub?.report) {
							const shownInfo = versionInfo(sub.report);
							lib.setVersionInfo(String(body.doc.id), String(body.doc.version), shownInfo.modules, shownInfo.changelog);
							const icon = typeof (sub.report as any)?.icon === "string" ? iconOf((sub.report as any).icon) : undefined;
							if (icon) lib.putIcon(String(body.doc.id), icon);
						}
						break;
					}
					case "yank": acceptYank(lib, config.rootKeys, body.doc, t); break;
					default: throw new Refused("not a kind of approval");
				}
			});
		} catch (e) {
			if (e instanceof Refused || e instanceof InvalidStatement) return c.json({ error: e.message }, 422);
			throw e;
		}
		if (sub && (body.kind === "version" || body.kind === "listing") && !["signed", "rejected"].includes(sub.status)) {
			lib.updateSubmission(sub.id, { status: "signed", reason: null }, t);
			check(sub.id, body.kind === "version" && typeof body.doc?.id === "string"
				? listedCheck(sub.tag, body.doc.id, shown(body.doc.version, 64), sub.report as Record<string, unknown> | null, sub.builder === "open" ? runOf(sub.report) : undefined)
				: approvedCheck(sub.tag));
		}
		changed();
		return c.json({ ok: true });
	});

	app.post("/v1/library/listings/:id/pause", c => {
		const no = adminOnly(c);
		if (no) return no;
		const l = lib.listing(c.req.param("id"));
		if (!l) return c.json({ error: "No such listing" }, 404);
		lib.pauseListingsOf(l.repoId, now());
		changed();
		return c.json({ ok: true });
	});

	// ---- jobs -----------------------------------------------------------------------------------------------------

	async function runJob(kind: string, payload: any): Promise<void> {
		if (kind === "deploy") {
			if (!config.deployHook) return;
			const url = new URL(config.deployHook);
			url.searchParams.set("force", "true");
			const res = await fetch(url, {
				method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
				headers: config.deployToken ? { Authorization: `Bearer ${config.deployToken}` } : {},
			});
			if (!res.ok) throw new Error(`deploy hook: HTTP ${res.status}`);
			return;
		}
		if (!github) throw new Error("GitHub isn't set up");
		if (kind === "checks") {
			if (lib.pendingChecks(1).length > 0) await github.dispatch(config.builderClosedRepo, "checks.yml", {});
			return;
		}
		const sub = lib.submission(Number(payload?.submission));
		if (!sub) return;
		if (kind === "dispatch") {
			if (sub.status !== "queued") return;
			const since = now() - 6 * HOUR;
			const repo = lib.repo(sub.repoId);
			if (lib.activeBuilds(since) >= MAX_BUILDS || (repo && lib.activeBuilds(since, repo.installationId) >= MAX_BUILDS_EACH)) throw new Busy();
			await github.dispatch(sub.builder === "open" ? config.builderOpenRepo : config.builderClosedRepo, "build.yml", { submission: String(sub.id) });
			lib.updateSubmission(sub.id, { dispatchedAt: now() }, now());
		} else if (kind === "check-run") {
			// Queued before the private builder posted check runs: handed over the new way.
			check(sub.id, payload.run as CheckRun);
		}
	}

	let running = false;
	async function tick(): Promise<void> {
		if (running) return;
		running = true;
		try {
			for (const job of lib.dueJobs(now())) {
				try {
					await runJob(job.kind, job.payload);
					lib.finishJob(job.id);
				} catch (e) {
					if (e instanceof Busy) continue; // waits for a free builder, without counting as a failure
					const giveUp = job.attempts + 1 >= 6;
					lib.retryJob(job.id, e instanceof Error ? e.message : String(e), now() + 2 ** job.attempts * MINUTE, giveUp);
					if (giveUp) console.error(`library job ${job.kind} gave up`, e);
				}
			}
		} finally {
			running = false;
		}
	}

	// Players' accounts and invite-only addons (accounts.ts).
	const accounts = accountRoutes({ app, db, lib, mojang, now, who, changed, apiOrigin: config.apiOrigin ?? "https://api.myriadclient.dev" });

	function start(): void {
		setInterval(() => void tick(), 30_000).unref();
		setInterval(() => {
			reads.sweep(now());
			writes.sweep(now());
			accounts.sweep();
			lib.forgetDeliveries(now() - 30 * 24 * HOUR);
		}, 10 * MINUTE).unref();
		if (indexKey) {
			const snap = lib.snapshot();
			if (!snap || now() / 1000 - snap.issued > 3600) rebuild();
			setInterval(rebuild, HOUR).unref();
		}
	}

	return { app, tick, start, store: lib };
}

function summary(lib: LibraryStore, l: ListingRow) {
	const latest = lib.versions(l.id, 1)[0];
	return {
		id: l.id, name: l.name, description: l.description, author: l.author, repo: showsAll(l, "repo") ? l.repoName || null : null,
		badge: l.source === "open" ? "verified" : "reviewed", icon: lib.icon(l.id) ? `/v1/library/addons/${l.id}/icon.png` : null, access: l.access,
		latest: latest ? { version: latest.version, minecraft: latest.minecraft, added: new Date(latest.createdAt).toISOString() } : null,
		modules: latest?.modules ?? [],
		changelog: latest?.changelog && showsAll(l, "changelog") ? { version: latest.version, text: latest.changelog } : null,
		updated: new Date(l.updatedAt).toISOString(),
	};
}

/** The builder's GitHub Actions run, from its report, for a link (only digits pass). */
function runOf(report: unknown): string | undefined {
	const r = report && typeof report === "object" ? (report as Record<string, unknown>).run : undefined;
	return typeof r === "string" && /^\d{1,20}$/.test(r) ? r : undefined;
}

function signedListing(l: ListingRow) {
	return {
		id: l.id, revision: l.revision, repoId: l.repoId, ownerId: l.ownerId, source: l.source,
		...(l.source === "closed" ? { downloadRepoId: l.downloadRepoId } : {}), build: l.build, provides: l.provides, keys: l.keys, signatures: l.sigs,
	};
}

/** A PNG of at most 64 KB, from base64; anything else is dropped. The builder has already re-encoded it. */
function iconOf(v: unknown): Buffer | undefined {
	if (typeof v !== "string" || v.length > Math.ceil(MAX_ICON / 3) * 4 + 4) return undefined;
	const b = Buffer.from(v, "base64");
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return b.length > 8 && b.length <= MAX_ICON && b.subarray(0, 8).equals(PNG) ? b : undefined;
}

async function jsonBody(c: Context): Promise<Record<string, any> | undefined> {
	if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return undefined;
	try {
		const v = JSON.parse(await c.req.text());
		return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

function tooMany(c: Context) {
	c.header("Retry-After", "60");
	return c.json({ error: "Too many requests; slow down" }, 429);
}

function socketAddress(c: Context): string | undefined {
	return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}
