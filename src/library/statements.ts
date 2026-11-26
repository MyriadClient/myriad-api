import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

/**
 * The statements the Myriad Library's keys sign, spelled exactly as Myriad's core reads them (core's
 * `LibraryStatements`; the tests pin signatures made by the Gradle plugin to the same bytes). Each is built from
 * checked fields, one `name=value` line each ending in `\n`, the first line naming the kind so a signature on one kind
 * never counts as another. Anything that doesn't pass is never built.
 */

export const ID = /^[a-z][a-z0-9_-]{1,63}$/;
export const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const COMMIT = /^[0-9a-f]{40}$/;
export const MAX_JAR = 64 * 1024 * 1024;
const KEY = /^ed25519:[A-Za-z0-9_-]{43}$/;

export type Role = "listing" | "version" | "index";
export type Source = "open" | "closed";

export class InvalidStatement extends Error {}

export interface Sig {
	key: string;
	sig: string;
}

export interface KeyCert {
	key: string;
	role: Role;
	notAfter: number;
}

export interface Revocations {
	seq: number;
	keys: string[];
}

export interface Listing {
	id: string;
	revision: number;
	repoId: number;
	ownerId: number;
	source: Source;
	downloadRepoId: number;
	build: string;
	provides: string[];
	keys: string[];
}

export interface Version {
	id: string;
	version: string;
	size: number;
	sha256: string;
	commit: string;
}

export interface Yank {
	id: string;
	version: string;
	sha256: string;
}

export interface Snapshot {
	issued: number;
	expires: number;
	bodySha256: string;
}

function check(ok: boolean, what: string): void {
	if (!ok) throw new InvalidStatement(what);
}

function positive(n: unknown, what: string): number {
	check(typeof n === "number" && Number.isSafeInteger(n) && n > 0, `${what} isn't a positive whole number`);
	return n as number;
}

export function isKey(s: unknown): s is string {
	return typeof s === "string" && KEY.test(s) && rawKey(s).length === 32;
}

function sortedKeys(keys: unknown, min: number, max: number): string[] {
	check(Array.isArray(keys), "keys aren't a list");
	const out: string[] = [];
	for (const k of keys as unknown[]) {
		check(isKey(k), "a key isn't an Ed25519 key");
		if (!out.includes(k as string)) out.push(k as string);
	}
	check(out.length >= min && out.length <= max, `between ${min} and ${max} keys`);
	return out.sort();
}

const ascii = (s: string) => Buffer.from(s, "ascii");

export function keyCertBytes(c: KeyCert): Buffer {
	check(isKey(c.key), "not an Ed25519 key");
	check(c.role === "listing" || c.role === "version" || c.role === "index", "not a role");
	if (c.role === "index") positive(c.notAfter, "not-after");
	else check(c.notAfter === 0, "only an index key's certificate expires");
	return ascii(`myriad-library-key:1\nkey=${c.key}\nrole=${c.role}${c.role === "index" ? `\nnot-after=${c.notAfter}` : ""}\n`);
}

export function revocationsBytes(r: Revocations): Buffer {
	positive(r.seq, "seq");
	return ascii(`myriad-library-revocations:1\nseq=${r.seq}\n${sortedKeys(r.keys, 0, 64).map(k => `key=${k}\n`).join("")}`);
}

export function listingBytes(l: Listing): Buffer {
	check(ID.test(l.id), "not a mod id");
	positive(l.revision, "revision");
	positive(l.repoId, "repo id");
	positive(l.ownerId, "owner id");
	check(l.source === "open" || l.source === "closed", "not a source");
	if (l.source === "closed") positive(l.downloadRepoId, "download repo id");
	else check(l.downloadRepoId === 0, "an open listing has no download repository");
	check(SHA256.test(l.build), "not a build hash");
	check(Array.isArray(l.provides), "provides isn't a list");
	const provides: string[] = [];
	for (const p of l.provides) {
		check(typeof p === "string" && ID.test(p) && p !== l.id, "provides holds something that isn't another mod id");
		if (!provides.includes(p)) provides.push(p);
	}
	check(provides.length <= 16, "provides too many ids");
	provides.sort();
	return ascii(`myriad-library-listing:1\nid=${l.id}\nrevision=${l.revision}\nrepo-id=${l.repoId}\nowner-id=${l.ownerId}\nsource=${l.source}`
		+ (l.source === "closed" ? `\ndownload-repo-id=${l.downloadRepoId}` : "")
		+ `\nbuild=${l.build}\nprovides=${provides.join(",")}\n${sortedKeys(l.keys, 1, 8).map(k => `key=${k}\n`).join("")}`);
}

export function versionBytes(v: Version): Buffer {
	check(ID.test(v.id), "not a mod id");
	check(VERSION.test(v.version), "not a version");
	check(positive(v.size, "size") <= MAX_JAR, "too big");
	check(SHA256.test(v.sha256), "not a SHA-256");
	check(COMMIT.test(v.commit), "not a commit");
	return ascii(`myriad-library-version:1\nid=${v.id}\nversion=${v.version}\nsize=${v.size}\nsha256=${v.sha256}\ncommit=${v.commit}\n`);
}

export function yankBytes(y: Yank): Buffer {
	check(ID.test(y.id), "not a mod id");
	check(VERSION.test(y.version), "not a version");
	check(SHA256.test(y.sha256), "not a SHA-256");
	return ascii(`myriad-library-yank:1\nid=${y.id}\nversion=${y.version}\nsha256=${y.sha256}\n`);
}

export function snapshotBytes(s: Snapshot): Buffer {
	positive(s.issued, "issued");
	check(positive(s.expires, "expires") > s.issued, "expires comes after issued");
	check(SHA256.test(s.bodySha256), "not a SHA-256");
	return ascii(`myriad-library-snapshot:1\nissued=${s.issued}\nexpires=${s.expires}\nbody-sha256=${s.bodySha256}\n`);
}

/** A developer's signature on a release (phase 1's `myriad-addon-release:1`). */
export function releaseBytes(v: Omit<Version, "commit">): Buffer {
	check(ID.test(v.id) && VERSION.test(v.version) && positive(v.size, "size") > 0 && SHA256.test(v.sha256), "not a release");
	return ascii(`myriad-addon-release:1\nid=${v.id}\nversion=${v.version}\nsize=${v.size}\nsha256=${v.sha256}\n`);
}

// ---- keys and signatures ----------------------------------------------------------------------------------------

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
/** The order of Ed25519's base point. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function rawKey(text: string): Buffer {
	return Buffer.from(text.slice("ed25519:".length), "base64url");
}

export function publicKey(text: string): KeyObject {
	return createPublicKey({ key: Buffer.concat([SPKI, rawKey(text)]), format: "der", type: "spki" });
}

/** A private key from `ed25519-private:<base64url seed>`, and its public key's text. */
export function privateKey(text: string): { key: KeyObject; publicText: string } {
	const m = /^ed25519-private:([A-Za-z0-9_-]{43})$/.exec(text.trim());
	if (!m) throw new InvalidStatement("not a Myriad private key");
	const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(m[1]!, "base64url")]), format: "der", type: "pkcs8" });
	const der = createPublicKey(key).export({ format: "der", type: "spki" });
	return { key, publicText: `ed25519:${der.subarray(der.length - 32).toString("base64url")}` };
}

/** The first 8 bytes of the key's SHA-256, in hex: how a signature names its key (a label, never trusted). */
export function keyId(text: string): string {
	return createHash("sha256").update(rawKey(text)).digest("hex").slice(0, 16);
}

export function signWith(key: { key: KeyObject; publicText: string }, message: Buffer): Sig {
	return { key: keyId(key.publicText), sig: edSign(null, message, key.key).toString("base64url") };
}

export function verify(message: Buffer, sig: string, key: string): boolean {
	if (typeof sig !== "string" || sig.length > 100 || !/^[A-Za-z0-9_-]+$/.test(sig)) return false;
	const raw = Buffer.from(sig, "base64url");
	if (raw.length !== 64) return false;
	// Refuse a malleated copy of a valid signature: S (the last 32 bytes, little-endian) must be below L.
	let s = 0n;
	for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(raw[i]!);
	if (s >= L) return false;
	try {
		return edVerify(null, message, publicKey(key), raw);
	} catch {
		return false;
	}
}

/** The trusted key that made one of `sigs` over `message`, or undefined. Key ids are only labels: every key is tried. */
export function signer(message: Buffer, sigs: unknown, trusted: string[]): string | undefined {
	if (!Array.isArray(sigs)) return undefined;
	for (const s of sigs.slice(0, 8)) {
		if (!s || typeof s !== "object" || typeof (s as Sig).sig !== "string") continue;
		for (const k of trusted) if (verify(message, (s as Sig).sig, k)) return k;
	}
	return undefined;
}

export function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}
