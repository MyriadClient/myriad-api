/*
 * Players' accounts and invite-only addons.
 *
 * Linking: a player proves they own a Minecraft account the way joining a server does. The game asks for a one-time
 * nonce, tells Mojang it's joining "server" sha1("myriad-link:" + nonce) with its own access token (which goes only to
 * Mojang, never here), and this API asks Mojang whether that account just joined that server. If it did, the player gets
 * a session: an opaque token, kept here only as its hash, good for 30 days of use and revocable.
 *
 * Invites: the developer's tool makes each code, signs a request with a developer key the listing names, and sends only
 * the code's hash. A player with a session redeems the code for a grant on that listing. Only an account with a grant
 * can fetch an invite-only listing's jars, which this API takes from the developer's private releases repository.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DatabaseSync } from "node:sqlite";
import { RateLimit } from "../rateLimit.ts";
import type { GitHub } from "./github.ts";
import { listingLive, shown, sigs } from "./rules.ts";
import { inviteBytes, InvalidStatement, type InviteAction, type InviteRequest, MAX_JAR, NONCE, signer, UUID } from "./statements.ts";
import type { LibraryStore } from "./store.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NONCE_LIFE = 2 * MINUTE;
const SESSION_LIFE = 30 * DAY;
/** A developer's signed request counts only this close to the API's clock, and only once. */
const REQUEST_WINDOW = 5 * MINUTE;
const SESSION = /^Bearer (myr_s_[A-Za-z0-9_-]{43})$/;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
/** A code as typed, made canonical: base32 letters only, 26 random and one checksum. */
const CODE = /^[A-Z2-7]{27}$/;

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

/** Mojang's side of the handshake: whether `name` just joined `serverId`, and which account that is. */
export interface Mojang {
	hasJoined(name: string, serverId: string): Promise<{ id: string; name: string } | undefined>;
}

export const realMojang: Mojang = {
	async hasJoined(name, serverId) {
		const url = `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverId)}`;
		const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "myriad-api" } });
		if (res.status === 204) return undefined;
		if (!res.ok) throw new Error(`Mojang: HTTP ${res.status}`);
		const p = await res.json() as { id?: unknown; name?: unknown };
		return typeof p.id === "string" && UUID.test(p.id) && typeof p.name === "string" && NAME.test(p.name) ? { id: p.id, name: p.name } : undefined;
	},
};

/** The "server" a link joins: Java's `new BigInteger(sha1(...)).toString(16)`, as Minecraft spells server hashes. */
export function serverIdFor(nonce: string): string {
	const digest = createHash("sha1").update(`myriad-link:${nonce}`, "utf8").digest();
	let n = BigInt("0x" + digest.toString("hex"));
	if (digest[0]! & 0x80) n -= 1n << 160n;
	return n < 0n ? "-" + (-n).toString(16) : n.toString(16);
}

/** A code as players type it (`myr-ABCD-…`, any case, with or without dashes), made canonical, or undefined. */
export function canonicalCode(v: unknown): string | undefined {
	if (typeof v !== "string" || v.length > 64) return undefined;
	const c = v.trim().toUpperCase().replace(/^MYR-?/, "").replace(/[\s-]/g, "");
	return CODE.test(c) ? c : undefined;
}

type Row = Record<string, unknown>;

export interface Session {
	id: number;
	uuid: string;
	name: string;
}

/** The accounts' tables (migration 5). Tokens and codes are kept only as hashes. */
export class AccountStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	addNonce(hash: string, now: number): void {
		this.db.prepare("INSERT INTO auth_nonces (nonce_hash, created) VALUES (?, ?)").run(hash, now);
	}

	/** Uses a nonce up: true only once, and only while it's fresh. */
	takeNonce(hash: string, now: number): boolean {
		const r = this.db.prepare("DELETE FROM auth_nonces WHERE nonce_hash = ? RETURNING created").get(hash) as Row | undefined;
		return r !== undefined && now - Number(r.created) <= NONCE_LIFE;
	}

	addSession(tokenHash: string, uuid: string, name: string, label: string, now: number): number {
		const r = this.db.prepare("INSERT INTO auth_sessions (token_hash, uuid, name, label, created, last_used, expires) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(tokenHash, uuid, name, label, now, now, now + SESSION_LIFE);
		return Number(r.lastInsertRowid);
	}

	/** The session a token is, if it's live; each use keeps it alive for another 30 days (written at most hourly). */
	session(tokenHash: string, now: number): Session | undefined {
		const r = this.db.prepare("SELECT id, uuid, name, last_used, expires FROM auth_sessions WHERE token_hash = ?").get(tokenHash) as Row | undefined;
		if (!r || Number(r.expires) <= now) return undefined;
		if (now - Number(r.last_used) > HOUR) this.db.prepare("UPDATE auth_sessions SET last_used = ?, expires = ? WHERE id = ?").run(now, now + SESSION_LIFE, r.id as number);
		return { id: Number(r.id), uuid: String(r.uuid), name: String(r.name) };
	}

	sessionsOf(uuid: string, now: number): { id: number; label: string; created: number; lastUsed: number }[] {
		return (this.db.prepare("SELECT id, label, created, last_used FROM auth_sessions WHERE uuid = ? AND expires > ? ORDER BY last_used DESC").all(uuid, now) as Row[])
			.map(r => ({ id: Number(r.id), label: String(r.label), created: Number(r.created), lastUsed: Number(r.last_used) }));
	}

	endSession(id: number, uuid: string): boolean {
		return Number(this.db.prepare("DELETE FROM auth_sessions WHERE id = ? AND uuid = ?").run(id, uuid).changes) === 1;
	}

	/** A developer request's nonce, seen once; false the second time. */
	seeRequest(nonce: string, now: number): boolean {
		return Number(this.db.prepare("INSERT OR IGNORE INTO library_requests (nonce, seen) VALUES (?, ?)").run(nonce, now).changes) === 1;
	}

	addInvite(listingId: string, codeHash: string, uses: number, expires: number, label: string, now: number): number | undefined {
		const r = this.db.prepare("INSERT OR IGNORE INTO library_invites (listing_id, code_hash, max_uses, uses_left, expires, label, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(listingId, codeHash, uses, uses, expires, label, now);
		return Number(r.changes) === 1 ? Number(r.lastInsertRowid) : undefined;
	}

	invites(listingId: string) {
		return (this.db.prepare("SELECT id, label, max_uses, uses_left, expires, created, revoked FROM library_invites WHERE listing_id = ? ORDER BY id").all(listingId) as Row[])
			.map(r => ({ id: Number(r.id), label: String(r.label), maxUses: Number(r.max_uses), usesLeft: Number(r.uses_left), expires: Number(r.expires),
				created: Number(r.created), revoked: Number(r.revoked) === 1 }));
	}

	revokeInvite(listingId: string, id: number): boolean {
		return Number(this.db.prepare("UPDATE library_invites SET revoked = 1 WHERE id = ? AND listing_id = ?").run(id, listingId).changes) === 1;
	}

	/**
	 * Redeems a code for `uuid`: a grant on its listing, one use taken (none when the account already holds a grant).
	 * Returns the listing, or undefined when the code doesn't work. One transaction, so a code's last use goes once.
	 */
	redeem(codeHash: string, uuid: string, name: string, live: (listingId: string) => boolean, now: number): string | undefined {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const inv = this.db.prepare("SELECT id, listing_id, uses_left, expires, revoked FROM library_invites WHERE code_hash = ?").get(codeHash) as Row | undefined;
			if (!inv || Number(inv.revoked) === 1 || Number(inv.expires) <= now || Number(inv.uses_left) <= 0 || !live(String(inv.listing_id))) {
				this.db.exec("ROLLBACK");
				return undefined;
			}
			const listingId = String(inv.listing_id);
			const held = this.db.prepare("SELECT revoked FROM library_grants WHERE listing_id = ? AND uuid = ?").get(listingId, uuid) as Row | undefined;
			// A revoked grant stays revoked: no code brings it back, only the developer (restore-grant).
			if (held && Number(held.revoked) === 1) {
				this.db.exec("ROLLBACK");
				return undefined;
			}
			if (!held) {
				this.db.prepare("UPDATE library_invites SET uses_left = uses_left - 1 WHERE id = ?").run(inv.id as number);
				this.db.prepare("INSERT INTO library_grants (listing_id, uuid, name, invite_id, created, revoked) VALUES (?, ?, ?, ?, ?, 0)")
					.run(listingId, uuid, name, inv.id as number, now);
			}
			this.db.exec("COMMIT");
			return listingId;
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	hasGrant(listingId: string, uuid: string): boolean {
		return this.db.prepare("SELECT 1 FROM library_grants WHERE listing_id = ? AND uuid = ? AND revoked = 0").get(listingId, uuid) !== undefined;
	}

	grantsOf(uuid: string): string[] {
		return (this.db.prepare("SELECT listing_id FROM library_grants WHERE uuid = ? AND revoked = 0 ORDER BY listing_id").all(uuid) as Row[]).map(r => String(r.listing_id));
	}

	grants(listingId: string) {
		return (this.db.prepare("SELECT uuid, name, invite_id, created, revoked FROM library_grants WHERE listing_id = ? ORDER BY created").all(listingId) as Row[])
			.map(r => ({ uuid: String(r.uuid), name: String(r.name), invite: r.invite_id === null ? null : Number(r.invite_id), created: Number(r.created), revoked: Number(r.revoked) === 1 }));
	}

	revokeGrant(listingId: string, uuid: string): boolean {
		return Number(this.db.prepare("UPDATE library_grants SET revoked = 1 WHERE listing_id = ? AND uuid = ?").run(listingId, uuid).changes) === 1;
	}

	restoreGrant(listingId: string, uuid: string): boolean {
		return Number(this.db.prepare("UPDATE library_grants SET revoked = 0 WHERE listing_id = ? AND uuid = ?").run(listingId, uuid).changes) === 1;
	}

	downloadsSince(listingId: string, uuid: string, version: string, since: number): number {
		return Number((this.db.prepare("SELECT COUNT(*) AS n FROM library_downloads WHERE listing_id = ? AND uuid = ? AND version = ? AND at >= ?")
			.get(listingId, uuid, version, since) as Row).n);
	}

	noteDownload(listingId: string, uuid: string, version: string, now: number): void {
		this.db.prepare("INSERT INTO library_downloads (listing_id, uuid, version, at) VALUES (?, ?, ?, ?)").run(listingId, uuid, version, now);
	}

	forgetOld(now: number): void {
		this.db.prepare("DELETE FROM auth_nonces WHERE created < ?").run(now - NONCE_LIFE);
		this.db.prepare("DELETE FROM auth_sessions WHERE expires <= ?").run(now);
		this.db.prepare("DELETE FROM library_requests WHERE seen < ?").run(now - 2 * REQUEST_WINDOW);
		this.db.prepare("DELETE FROM library_downloads WHERE at < ?").run(now - 30 * DAY);
	}
}

export interface AccountDeps {
	app: Hono;
	db: DatabaseSync;
	lib: LibraryStore;
	github: GitHub | undefined;
	mojang: Mojang;
	now: () => number;
	who: (c: Context) => string;
	/** This API's own origin: developer requests signed for any other are refused. */
	apiOrigin: string;
}

/** The accounts' routes, on the Library's app; returns the hourly housekeeping. */
export function accountRoutes({ app, db, lib, github, mojang, now, who, apiOrigin }: AccountDeps): { sweep: () => void } {
	const store = new AccountStore(db);
	const linking = new RateLimit(10, MINUTE);
	const reads = new RateLimit(120, MINUTE);
	const writes = new RateLimit(30, MINUTE);
	const redeemsBySession = new RateLimit(10, HOUR);
	const redeemsByAddress = new RateLimit(30, HOUR);
	const downloads = new RateLimit(30, HOUR);
	const small = bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "Too big" }, 413) });

	const tooMany = (c: Context) => {
		c.header("Retry-After", "60");
		return c.json({ error: "Too many requests; slow down" }, 429);
	};
	const body = async (c: Context): Promise<Record<string, unknown> | undefined> => {
		if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return undefined;
		try {
			const v = JSON.parse(await c.req.text());
			return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
		} catch {
			return undefined;
		}
	};
	/** The session the request's bearer token is, or undefined. */
	const sessionOf = (c: Context): Session | undefined => {
		const token = SESSION.exec(c.req.header("authorization") ?? "")?.[1];
		return token ? store.session(sha256(token), now()) : undefined;
	};
	const inviteListing = (id: string) => {
		const l = lib.listing(id);
		return l && l.access === "invite" && listingLive(lib, l) ? l : undefined;
	};

	// ---- linking a Minecraft account -------------------------------------------------------------------------------

	app.post("/v1/auth/minecraft/start", c => {
		if (!linking.tryHit(who(c), now())) return tooMany(c);
		const nonce = b64url(randomBytes(32));
		store.addNonce(sha256(nonce), now());
		c.header("Cache-Control", "no-store");
		return c.json({ nonce });
	});

	app.post("/v1/auth/minecraft/finish", small, async c => {
		if (!linking.tryHit(who(c), now())) return tooMany(c);
		const b = await body(c);
		const nonce = typeof b?.nonce === "string" && NONCE.test(b.nonce) ? b.nonce : undefined;
		const name = typeof b?.name === "string" && NAME.test(b.name) ? b.name : undefined;
		if (!nonce || !name) return c.json({ error: "Not a link request" }, 400);
		if (!store.takeNonce(sha256(nonce), now())) return c.json({ error: "That link request is used or too old; start again" }, 401);
		let profile: { id: string; name: string } | undefined;
		try {
			profile = await mojang.hasJoined(name, serverIdFor(nonce));
		} catch {
			return c.json({ error: "Mojang couldn't be asked; try again in a moment" }, 503);
		}
		if (!profile) return c.json({ error: "Mojang doesn't know of that sign-in" }, 401);
		const token = "myr_s_" + b64url(randomBytes(32));
		const label = shown(b?.label, 40) || "Minecraft";
		store.addSession(sha256(token), profile.id, profile.name, label, now());
		c.header("Cache-Control", "no-store");
		return c.json({ token, uuid: profile.id, name: profile.name });
	});

	app.get("/v1/auth/session", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		const s = sessionOf(c);
		if (!s) return c.json({ error: "Not signed in" }, 401);
		c.header("Cache-Control", "no-store");
		return c.json({ uuid: s.uuid, name: s.name, grants: store.grantsOf(s.uuid).filter(id => inviteListing(id)) });
	});

	app.delete("/v1/auth/session", c => {
		if (!writes.tryHit(who(c), now())) return tooMany(c);
		const s = sessionOf(c);
		if (!s) return c.json({ error: "Not signed in" }, 401);
		store.endSession(s.id, s.uuid);
		return c.json({ ok: true });
	});

	app.get("/v1/auth/sessions", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		const s = sessionOf(c);
		if (!s) return c.json({ error: "Not signed in" }, 401);
		c.header("Cache-Control", "no-store");
		return c.json(store.sessionsOf(s.uuid, now()).map(x => ({ ...x, current: x.id === s.id, created: new Date(x.created).toISOString(), lastUsed: new Date(x.lastUsed).toISOString() })));
	});

	app.delete("/v1/auth/sessions/:id", c => {
		if (!writes.tryHit(who(c), now())) return tooMany(c);
		const s = sessionOf(c);
		if (!s) return c.json({ error: "Not signed in" }, 401);
		return store.endSession(Number(c.req.param("id")), s.uuid) ? c.json({ ok: true }) : c.json({ error: "No such session" }, 404);
	});

	// ---- the developer's invites -----------------------------------------------------------------------------------

	app.post("/v1/library/invites", small, async c => {
		if (!writes.tryHit(who(c), now())) return tooMany(c);
		const b = await body(c);
		const q = b?.request && typeof b.request === "object" ? b.request as Record<string, unknown> : undefined;
		if (!q) return c.json({ error: "Not an invite request" }, 400);
		const req: InviteRequest = {
			id: String(q.id ?? ""), action: String(q.action ?? "") as InviteAction, api: String(q.api ?? ""), issued: Number(q.issued), nonce: String(q.nonce ?? ""),
			...(q.codeSha256 !== undefined ? { codeSha256: String(q.codeSha256) } : {}), ...(q.uses !== undefined ? { uses: Number(q.uses) } : {}),
			...(q.notAfter !== undefined ? { notAfter: Number(q.notAfter) } : {}), ...(q.label !== undefined ? { label: String(q.label) } : {}),
			...(q.invite !== undefined ? { invite: Number(q.invite) } : {}), ...(q.uuid !== undefined ? { uuid: String(q.uuid) } : {}),
		};
		let bytes: Buffer;
		try {
			bytes = inviteBytes(req);
		} catch (e) {
			return c.json({ error: e instanceof InvalidStatement ? e.message : "Not an invite request" }, 400);
		}
		const listing = inviteListing(req.id);
		if (!listing) return c.json({ error: "No invite-only listing with that id" }, 404);
		let signed;
		try {
			signed = signer(bytes, sigs(b?.signatures), listing.keys);
		} catch {
			signed = undefined;
		}
		if (!signed) return c.json({ error: "Not signed by a developer key this listing names" }, 403);
		if (req.api !== apiOrigin) return c.json({ error: `That request was made for ${req.api}, not this API` }, 400);
		if (Math.abs(req.issued * 1000 - now()) > REQUEST_WINDOW) return c.json({ error: "The request's time is off; check your clock" }, 400);
		if (!store.seeRequest(req.nonce, now())) return c.json({ error: "That request was already made" }, 409);
		c.header("Cache-Control", "no-store");
		switch (req.action) {
			case "create": {
				if (req.notAfter! * 1000 <= now()) return c.json({ error: "That invite would already have expired" }, 400);
				const id = store.addInvite(listing.id, req.codeSha256!, req.uses!, req.notAfter! * 1000, req.label ?? "", now());
				return id === undefined ? c.json({ error: "That code already exists; make another" }, 409) : c.json({ invite: id });
			}
			case "list":
				return c.json(store.invites(listing.id).map(i => ({ ...i, expires: new Date(i.expires).toISOString(), created: new Date(i.created).toISOString() })));
			case "revoke":
				return store.revokeInvite(listing.id, req.invite!) ? c.json({ ok: true }) : c.json({ error: "No such invite" }, 404);
			case "grants":
				return c.json(store.grants(listing.id).map(g => ({ ...g, created: new Date(g.created).toISOString() })));
			case "revoke-grant":
				return store.revokeGrant(listing.id, req.uuid!) ? c.json({ ok: true }) : c.json({ error: "No such grant" }, 404);
			case "restore-grant":
				return store.restoreGrant(listing.id, req.uuid!) ? c.json({ ok: true }) : c.json({ error: "No such grant" }, 404);
		}
	});

	// ---- players: redeeming, grants, downloads ---------------------------------------------------------------------

	app.post("/v1/library/redeem", small, async c => {
		const s = sessionOf(c);
		if (!s) return c.json({ error: "Sign in with Minecraft first" }, 401);
		if (!redeemsBySession.tryHit(String(s.id), now()) || !redeemsByAddress.tryHit(who(c), now())) return tooMany(c);
		const b = await body(c);
		const code = canonicalCode(b?.code);
		// One answer for every failure: nothing says whether a code exists, expired or ran out.
		const listingId = code ? store.redeem(sha256(code), s.uuid, s.name, id => inviteListing(id) !== undefined, now()) : undefined;
		if (!listingId) return c.json({ error: "That code doesn't work" }, 404);
		return c.json({ listing: listingId, name: lib.listing(listingId)?.name ?? listingId });
	});

	app.get("/v1/library/grants", c => {
		if (!reads.tryHit(who(c), now())) return tooMany(c);
		const s = sessionOf(c);
		if (!s) return c.json({ error: "Not signed in" }, 401);
		c.header("Cache-Control", "no-store");
		return c.json(store.grantsOf(s.uuid).filter(id => inviteListing(id)));
	});

	app.get("/v1/library/private/:id/:version", async c => {
		const s = sessionOf(c);
		if (!s) return c.json({ error: "Not signed in" }, 401);
		if (!downloads.tryHit(String(s.id), now())) return tooMany(c);
		const listing = inviteListing(c.req.param("id"));
		if (!listing || !store.hasGrant(listing.id, s.uuid)) return c.json({ error: "No access to that addon" }, 403);
		const v = lib.version(listing.id, c.req.param("version"));
		const yanked = v && lib.yanks(listing.id).some(y => y.version === v.version && y.sha256 === v.sha256);
		if (!v || yanked || !v.assetId) return c.json({ error: "No such release" }, 404);
		if (store.downloadsSince(listing.id, s.uuid, v.version, now() - DAY) >= 10) return tooMany(c);
		const repo = lib.repo(listing.downloadRepoId);
		if (!repo || repo.removed || !github) return c.json({ error: "Its releases can't be reached" }, 503);
		let jar: Buffer;
		try {
			jar = await github.assetBytes(repo.installationId, repo.id, repo.fullName, v.assetId, Math.min(MAX_JAR, v.size));
		} catch {
			return c.json({ error: "Its release couldn't be fetched; try again later" }, 502);
		}
		// Exactly the jar the listing key signed, or nothing (the game checks it again).
		if (jar.length !== v.size || sha256(jar) !== v.sha256) return c.json({ error: "Its release isn't the jar the Library lists" }, 502);
		store.noteDownload(listing.id, s.uuid, v.version, now());
		return c.body(new Uint8Array(jar), 200, { "Content-Type": "application/java-archive", "Cache-Control": "no-store", "Content-Length": String(jar.length) });
	});

	return {
		sweep: () => {
			for (const r of [linking, reads, writes, redeemsBySession, redeemsByAddress, downloads]) r.sweep(now());
			store.forgetOld(now());
		},
	};
}
