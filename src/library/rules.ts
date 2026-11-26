import type { LibraryStore, ListingRow } from "./store.ts";
import {
	acceptedBytes, ID, InvalidStatement, isKey, keyCertBytes, listingBytes, releaseBytes, revocationsBytes, sha256Hex, signer, signWith, snapshotBytes, versionBytes, yankBytes,
	type KeyCert, type Listing, type privateKey, type Role, type Sig,
} from "./statements.ts";

/**
 * What the Library accepts, checked the way Myriad's core checks it (core's `LibraryIndex`), so the API never stores
 * anything a client would refuse. Signatures are the authority: a listing, version or yank is accepted because a
 * certified key signed it, never because of who sent it.
 */

/** Myriad's root keys, the same two core trusts (core's `RootKeys`). */
export const ROOT_KEYS = [
	"ed25519:nCz3FbS30fsLg-MkX2de8AOrACc3xUYYo_RYAwpvRww",
	"ed25519:50gMky_GrJ-mjBAlIKuWDURAFNzJYrBXzOUEuFG5RcI",
];

/** Ids nobody can claim through the GitHub App (Myriad's own come from Myriad's own repositories). */
export const RESERVED = /^(myriad.*|minecraft|java|fabric.*|fabricloader|quilt.*|forge|neoforge)$/;

export class Refused extends Error {}

const SNAPSHOT_LIFE = 48 * 3600;
const GITHUB_DOWNLOAD = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/releases\/download\/[A-Za-z0-9._+-]{1,100}\/[A-Za-z0-9._+-]{1,128}\.jar$/;

export function downloadable(url: unknown): url is string {
	return typeof url === "string" && GITHUB_DOWNLOAD.test(url) && !url.includes("/../") && !/\/\.[^/]*\.jar$/.test(url);
}

/** The Library keys in force: certified by a root key, not revoked, and (index keys) not expired. */
export function keys(store: LibraryStore, roots: string[], nowSeconds: number): Record<Role, string[]> {
	const revoked = new Set<string>();
	const rev = store.latestRevocations();
	if (rev && signer(revocationsBytes({ seq: rev.seq, keys: rev.keys }), rev.sigs, roots)) rev.keys.forEach(k => revoked.add(k));
	const out: Record<Role, string[]> = { listing: [], version: [], index: [] };
	for (const c of store.certs()) {
		if (revoked.has(c.key) || (c.role === "index" && nowSeconds >= c.notAfter)) continue;
		let bytes;
		try {
			bytes = keyCertBytes(c);
		} catch {
			continue;
		}
		if (signer(bytes, c.sigs, roots)) out[c.role].push(c.key);
	}
	return out;
}

function sigs(v: unknown): Sig[] {
	if (!Array.isArray(v) || v.length === 0 || v.length > 8) throw new Refused("signatures aren't a short list");
	return v.map(s => {
		if (!s || typeof s !== "object" || typeof s.key !== "string" || typeof s.sig !== "string" || s.key.length > 32 || s.sig.length > 100) throw new Refused("a signature isn't one");
		return { key: s.key, sig: s.sig };
	});
}

function obj(v: unknown, what: string): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Refused(`${what} isn't an object`);
	return v as Record<string, unknown>;
}

function str(v: unknown, what: string, max: number): string {
	if (typeof v !== "string" || v.length > max) throw new Refused(`${what} isn't text`);
	return v;
}

/** Display text: control characters, formatting codes and line breaks taken out, capped. */
export function shown(v: unknown, max: number): string {
	if (typeof v !== "string") return "";
	const cleaned = [...v].filter(ch => {
		const c = ch.codePointAt(0)!;
		return !(c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0xa7 || (c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0x2028 || c === 0x2029 || c === 0xfeff);
	});
	return cleaned.slice(0, max).join("").trim();
}

export function acceptCert(store: LibraryStore, roots: string[], body: unknown, now: number): KeyCert {
	const o = obj(body, "the certificate");
	const cert: KeyCert = { key: str(o.key, "key", 60), role: str(o.role, "role", 10) as Role, notAfter: o.notAfter === undefined ? 0 : Number(o.notAfter) };
	const s = sigs(o.signatures);
	if (!signer(keyCertBytes(cert), s, roots)) throw new Refused("the certificate isn't signed by a Myriad root key");
	store.putCert(cert, s, now);
	return cert;
}

export function acceptRevocations(store: LibraryStore, roots: string[], body: unknown): void {
	const o = obj(body, "the revocations");
	const seq = Number(o.seq);
	if (!Array.isArray(o.keys)) throw new Refused("keys aren't a list");
	const list = o.keys.map(k => str(k, "key", 60));
	const s = sigs(o.signatures);
	if (!signer(revocationsBytes({ seq, keys: list }), s, roots)) throw new Refused("the revocations aren't signed by a Myriad root key");
	const latest = store.latestRevocations();
	if (latest && seq <= latest.seq) throw new Refused("not newer than the revocations already held");
	store.putRevocations(seq, list, s);
}

/** A listing signed by a listing key, with what's shown about it. */
export function acceptListing(store: LibraryStore, roots: string[], body: unknown, now: number): ListingRow {
	const o = obj(body, "the listing");
	const l: Listing = {
		id: str(o.id, "id", 64), revision: Number(o.revision), repoId: Number(o.repoId), ownerId: Number(o.ownerId), source: str(o.source, "source", 10) as Listing["source"],
		downloadRepoId: o.downloadRepoId === undefined ? 0 : Number(o.downloadRepoId), build: str(o.build, "build", 64),
		provides: Array.isArray(o.provides) ? o.provides.map(p => str(p, "provides", 64)) : [], keys: Array.isArray(o.keys) ? o.keys.map(k => str(k, "key", 60)) : [],
	};
	const s = sigs(o.signatures);
	if (!signer(listingBytes(l), s, keys(store, roots, Math.floor(now / 1000)).listing)) throw new Refused("the listing isn't signed by a Myriad listing key");
	const before = store.listing(l.id);
	if (before && l.revision <= before.revision) throw new Refused("not newer than the listing already held");
	for (const other of store.listings(true)) {
		if (other.id === l.id) continue;
		const theirs = new Set([other.id, ...other.provides]);
		const clash = [l.id, ...l.provides].find(n => theirs.has(n));
		if (clash) throw new Refused(`${clash} is already listed as ${other.id}`);
		if (other.repoId === l.repoId) throw new Refused(`that repository is already listed as ${other.id}`);
	}
	const info = o.info === undefined ? {} : obj(o.info, "info");
	const repoName = shown(info.repo, 201);
	if (o.accepted !== undefined && (!Array.isArray(o.accepted) || o.accepted.length > 200)) throw new Refused("accepted findings aren't a short list");
	const accepted = ((o.accepted ?? []) as unknown[]).map(f => {
		if (typeof f !== "string" || !/^[!-<>-~]{1,300}$/.test(f)) throw new Refused("an accepted finding isn't one");
		return f;
	});
	// Accepted findings let later versions through unreviewed, so the listing key signs them too.
	const acceptedSigs = accepted.length === 0 ? [] : sigs(o.acceptedSignatures);
	if (accepted.length > 0 && !signer(acceptedBytes(l.id, l.revision, accepted), acceptedSigs, keys(store, roots, Math.floor(now / 1000)).listing)) {
		throw new Refused("the accepted findings aren't signed by a Myriad listing key");
	}
	const row = {
		...l, provides: [...new Set(l.provides)].sort(), keys: [...new Set(l.keys)].sort(), sigs: s, accepted: [...new Set(accepted)].sort(), acceptedSigs,
		name: shown(info.name, 64) || l.id, description: shown(info.description, 300), author: shown(info.author, 64),
		repoName: /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repoName) ? repoName : before?.repoName ?? "",
	};
	store.putListing(row, now);
	return store.listing(l.id)!;
}

/**
 * A release of a listed addon: signed by a listing key (or, for an open-source listing, a version key) and by one of the
 * listing's developer keys, downloadable from GitHub, and the only jar ever listed as that version.
 */
export function acceptVersion(store: LibraryStore, roots: string[], body: unknown, now: number): { added: boolean } {
	const o = obj(body, "the version");
	const id = str(o.id, "id", 64);
	const listing = store.listing(id);
	if (!listing || !listingLive(store, listing)) throw new Refused("no listing for that id");
	const v = { id, version: str(o.version, "version", 64), size: Number(o.size), sha256: str(o.sha256, "sha256", 64), commit: str(o.commit, "commit", 40) };
	const s = sigs(o.signatures);
	const k = keys(store, roots, Math.floor(now / 1000));
	const signers = listing.source === "open" ? [...k.listing, ...k.version] : k.listing;
	if (!signer(versionBytes(v), s, signers)) throw new Refused("the version isn't signed by a Myriad key that may sign it");
	const developer = sigs(o.developer);
	if (!signer(releaseBytes(v), developer, listing.keys)) throw new Refused("the version isn't signed by the listing's developer");
	if (!downloadable(o.url)) throw new Refused("the version isn't downloadable from a GitHub release");
	const minecraft = o.minecraft === undefined || o.minecraft === null ? null : shown(str(o.minecraft, "minecraft", 200), 200) || null;
	const held = store.version(id, v.version);
	if (held) {
		if (held.sha256 !== v.sha256) throw new Refused("that version is already listed with a different jar");
		return { added: false };
	}
	store.addVersion({ listingId: id, version: v.version, size: v.size, sha256: v.sha256, commit: v.commit, url: o.url, minecraft, sigs: s, developer, createdAt: now });
	return { added: true };
}

/** A yank, signed by any Library key or one of the listing's developer keys. */
export function acceptYank(store: LibraryStore, roots: string[], body: unknown, now: number): void {
	const o = obj(body, "the yank");
	const id = str(o.id, "id", 64);
	const listing = store.listing(id);
	if (!listing) throw new Refused("no listing for that id");
	const y = { id, version: str(o.version, "version", 64), sha256: str(o.sha256, "sha256", 64) };
	const s = sigs(o.signatures);
	const k = keys(store, roots, Math.floor(now / 1000));
	// Only the offline listing key and the addon's own developer keys: a yank is kept forever, so no online key may make one.
	if (!signer(yankBytes(y), s, [...k.listing, ...listing.keys])) throw new Refused("the yank isn't signed by a key that may yank");
	store.addYank({ listingId: id, version: y.version, sha256: y.sha256, sigs: s }, now);
}

/**
 * Whether a listing's repositories are still what it was approved for: known, not removed, owned by the listing's owner,
 * and (open source) public. Checked from state, so a missed GitHub event can't leave a transferred repository listed.
 */
export function listingLive(store: LibraryStore, l: ListingRow): boolean {
	if (l.paused) return false;
	const ok = (id: number, mustBePublic: boolean) => {
		const r = store.repo(id);
		return r !== undefined && !r.removed && r.ownerId === l.ownerId && !(mustBePublic && r.private);
	};
	return l.source === "open" ? ok(l.repoId, true) : ok(l.repoId, false) && ok(l.downloadRepoId, true);
}

/**
 * Builds and signs the index: every key certificate, the latest revocations, and each listing that isn't paused with
 * its newest ten versions and all its yanks. `issued` always moves forward, even within one second.
 */
export function buildSnapshot(store: LibraryStore, indexKey: ReturnType<typeof privateKey>, now: number): { issued: number; text: string; etag: string } {
	const last = store.snapshot();
	const issued = Math.max(Math.floor(now / 1000), (last?.issued ?? 0) + 1);
	const rev = store.latestRevocations();
	const body = {
		issued,
		expires: issued + SNAPSHOT_LIFE,
		certs: store.certs().map(c => ({ key: c.key, role: c.role, ...(c.role === "index" ? { notAfter: c.notAfter } : {}), signatures: c.sigs })),
		...(rev ? { revocations: { seq: rev.seq, keys: rev.keys, signatures: rev.sigs } } : {}),
		addons: store.listings().filter(l => listingLive(store, l)).map(l => ({
			listing: {
				id: l.id, revision: l.revision, repoId: l.repoId, ownerId: l.ownerId, source: l.source,
				...(l.source === "closed" ? { downloadRepoId: l.downloadRepoId } : {}), build: l.build, provides: l.provides, keys: l.keys, signatures: l.sigs,
			},
			info: { name: l.name, description: l.description, author: l.author, repo: l.repoName },
			versions: store.versions(l.id).map(v => ({
				version: v.version, size: v.size, sha256: v.sha256, commit: v.commit, url: v.url, ...(v.minecraft ? { minecraft: v.minecraft } : {}),
				signatures: v.sigs, developer: v.developer,
			})),
			yanks: store.yanks(l.id).map(y => ({ version: y.version, sha256: y.sha256, signatures: y.sigs })),
		})),
	};
	const bodyText = JSON.stringify(body);
	const snapshot = { issued, expires: body.expires, bodySha256: sha256Hex(Buffer.from(bodyText, "utf8")) };
	const text = JSON.stringify({ format: 1, body: bodyText, signatures: [signWith(indexKey, snapshotBytes(snapshot))] });
	const etag = `"${sha256Hex(text).slice(0, 32)}"`;
	store.putSnapshot(issued, text, etag);
	return { issued, text, etag };
}

export function checkId(id: unknown, ownerIsMyriad: boolean): string {
	if (typeof id !== "string" || !ID.test(id)) throw new Refused("not a mod id");
	if (RESERVED.test(id) && !ownerIsMyriad) throw new Refused(`the id ${id} is reserved`);
	return id;
}

export { InvalidStatement, isKey };
