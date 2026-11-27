import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import type { LibraryConfig } from "../src/library/config.ts";
import type { CheckRun, GitHub } from "../src/library/github.ts";
import { createLibrary } from "../src/library/library.ts";
import { canonicalCode, type Mojang, serverIdFor } from "../src/library/accounts.ts";
import {
	acceptedBytes, inviteBytes, type InviteRequest, keyCertBytes, listingBytes, privateKey, releaseBytes, sha256Hex, signer, signWith, snapshotBytes, versionBytes, yankBytes, type Listing,
} from "../src/library/statements.ts";
import { hashKey } from "../src/codes.ts";
import { migrate, SCHEMA_VERSION } from "../src/migrate.ts";

const key = (n: number) => privateKey(`ed25519-private:${Buffer.alloc(32, n).toString("base64url")}`);
const ROOT = key(1), LISTING = key(2), VERSION = key(3), INDEX = key(4), DEV = key(5), OTHER = key(7);
const ADMIN = "admin-token-aaaaaaaaaaaaaaaaaaaa", OPEN = "open-builder-token-aaaaaaaaaaaaa", CLOSED = "closed-builder-token-aaaaaaaaaaa";
const SECRET = "webhook-secret";
const MYRIAD_OWNER = 999;
const COMMIT = "c".repeat(40), BUILD = "b".repeat(64);

const base: Config = {
	port: 0, dbPath: ":memory:", siteUrl: "https://myriadclient.dev", maxShareBytes: 65536, uploadsPerHour: 100, uploadsPerDay: 100,
	globalUploadsPerHour: 1000, readsPerMinute: 1000, missesPerMinute: 1000, deletesPerHour: 100, trustedProxies: 1,
};

class FakeGitHub implements GitHub {
	dispatched: { repo: string; submission: number }[] = [];
	checks: { repo: string; run: CheckRun }[] = [];
	tokens: { installation: number; scope?: unknown }[] = [];
	async installationToken(installation: number, scope?: unknown) {
		this.tokens.push({ installation, scope });
		return "ghs_scoped";
	}
	async commitOf() {
		return "e".repeat(40);
	}
	async createCheckRun(_i: number, repo: string, _h: string, run: CheckRun) {
		this.checks.push({ repo, run });
		return 77;
	}
	async updateCheckRun(_i: number, repo: string, _id: number, run: CheckRun) {
		this.checks.push({ repo, run });
	}
	async dispatch(repo: string, submission: number) {
		this.dispatched.push({ repo, submission });
	}
	asset: Buffer = Buffer.alloc(0);
	assets: { installation: number; repoId: number; repo: string; assetId: number }[] = [];
	/** When set, downloads wait for it (to have several in flight at once). */
	assetGate?: Promise<void>;
	async assetBytes(installation: number, repoId: number, repo: string, assetId: number) {
		this.assets.push({ installation, repoId, repo, assetId });
		if (this.assetGate) await this.assetGate;
		return this.asset;
	}
}

/** Mojang, as tests want it: who has "joined" which server id. */
class FakeMojang implements Mojang {
	joined = new Map<string, { id: string; name: string }>();
	down = false;
	async hasJoined(name: string, serverId: string) {
		if (this.down) throw new Error("down");
		const p = this.joined.get(serverId);
		return p && p.name.toLowerCase() === name.toLowerCase() ? p : undefined;
	}
}

function setup(over: Partial<LibraryConfig> = {}) {
	let clock = 1_800_000_000_000;
	const now = () => clock;
	const store = new Store(":memory:");
	const github = new FakeGitHub();
	const config: LibraryConfig = {
		indexKey: `ed25519-private:${Buffer.alloc(32, 4).toString("base64url")}`,
		adminTokenSha256: hashKey(ADMIN), builderOpenTokenSha256: hashKey(OPEN), builderClosedTokenSha256: hashKey(CLOSED),
		webhookSecret: SECRET, builderOpenRepo: "MyriadClient/myriad-builder", builderClosedRepo: "MyriadClient/myriad-builder-private",
		myriadOwnerId: MYRIAD_OWNER, deployHook: undefined, rootKeys: [ROOT.publicText], submissionsPerDay: 20, ...over,
	};
	const mojang = new FakeMojang();
	const library = createLibrary(store.db, config, github, 1, now, mojang);
	const app = createApp(store, base, now, library);
	return { app, library, github, store, mojang, advance: (ms: number) => { clock += ms; }, now };
}

type App = ReturnType<typeof setup>["app"];
let ip = 0;
const req = (app: App, method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) =>
	app.request(path, {
		method,
		headers: { "x-forwarded-for": `10.0.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

function cert(k: ReturnType<typeof key>, role: "listing" | "version" | "index", signer_ = ROOT) {
	const c = { key: k.publicText, role, notAfter: role === "index" ? 1_900_000_000 : 0 };
	return { kind: "cert", doc: { ...c, signatures: [signWith(signer_, keyCertBytes(c))] } };
}

function listingDoc(l: Partial<Listing> = {}, by = LISTING) {
	const full: Listing = { id: "good-addon", revision: 1, repoId: 100, ownerId: 200, source: "open", downloadRepoId: 0, build: BUILD, provides: [], keys: [DEV.publicText], ...l };
	return { kind: "listing", doc: { ...full, signatures: [signWith(by, listingBytes(full))], info: { name: "Good\u0000 Addon‮", description: "Nice.", author: "dev", repo: "dev/good-addon" } } };
}

function versionDoc(version: string, sha = sha256Hex(version), by = VERSION, dev = DEV, id = "good-addon") {
	const v = { id, version, size: 1000, sha256: sha, commit: COMMIT };
	return {
		...v, url: `https://github.com/dev/${id}/releases/download/v${version}/${id}-${version}.jar`, minecraft: "~26.3",
		signatures: [signWith(by, versionBytes(v))], developer: [signWith(dev, releaseBytes(v))],
	};
}

async function ready(app: App) {
	// The listed repository, known from the App's installation, owned by the listing's owner.
	const repos = [{ id: 100, full_name: "dev/good-addon" }, { id: 101, full_name: "dev/closed-addon", private: true }, { id: 102, full_name: "dev/closed-addon-releases" }];
	assert.equal((await hook(app, "installation", installation(repos))).status, 202);
	for (const c of [cert(LISTING, "listing"), cert(VERSION, "version"), cert(INDEX, "index")]) assert.equal((await req(app, "POST", "/v1/library/approvals", c, ADMIN)).status, 200);
}

function hook(app: App, event: string, payload: unknown, guid = crypto.randomUUID(), secret = SECRET) {
	const body = JSON.stringify(payload);
	return app.request("/v1/github/webhook", {
		method: "POST",
		headers: {
			"content-type": "application/json", "x-github-event": event, "x-github-delivery": guid,
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		},
		body,
	});
}

const installation = (repos: { id: number; full_name: string; private?: boolean }[], owner = 200) => ({
	action: "created", installation: { id: 5, account: { id: owner, login: "dev" } }, repositories: repos,
});
const released = (repoId: number, full: string, tag: string, priv = false) => ({
	action: "published", installation: { id: 5 }, repository: { id: repoId, full_name: full, private: priv, owner: { id: 200 } },
	release: { tag_name: tag, draft: false, prerelease: false, assets: [{ browser_download_url: `https://github.com/${full}/releases/download/${tag}/x-1.0.0.jar` }] },
});

async function index(app: App) {
	const res = await req(app, "GET", "/v1/index.json");
	assert.equal(res.status, 200);
	const w = await res.json() as { body: string; signatures: { key: string; sig: string }[] };
	const body = JSON.parse(w.body);
	// The snapshot verifies with the index key, over exactly this body.
	assert.ok(signer(snapshotBytes({ issued: body.issued, expires: body.expires, bodySha256: sha256Hex(Buffer.from(w.body, "utf8")) }), w.signatures, [INDEX.publicText]));
	return { body, etag: res.headers.get("etag")! };
}

test("a database from before migrations keeps its shares", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE shares (code TEXT PRIMARY KEY, document TEXT NOT NULL, delete_hash TEXT NOT NULL, created_at INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0)");
	db.exec("INSERT INTO shares (code, document, delete_hash, created_at) VALUES ('myriad_abcdef', '{}', 'x', 1)");
	migrate(db);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n, 1);
	assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
	migrate(db); // again: nothing to do
	db.exec("PRAGMA user_version = 99");
	assert.throws(() => migrate(db));
});

test("the index is signed, cached with an ETag, and answers 304", async () => {
	const { app } = setup();
	await ready(app);
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/approvals", { kind: "version", doc: versionDoc("1.0.0", undefined, LISTING) }, ADMIN)).status, 200);
	const { body, etag } = await index(app);
	assert.equal(body.addons.length, 1);
	assert.equal(body.addons[0].info.name, "Good Addon");
	assert.equal(body.addons[0].versions[0].version, "1.0.0");
	assert.equal((await req(app, "GET", "/v1/index.json", undefined, undefined, { "if-none-match": etag })).status, 304);
	assert.equal((await req(app, "GET", "/v1/index.json", undefined, undefined, { "if-none-match": `W/${etag}` })).status, 304);
	const list = await (await req(app, "GET", "/v1/library/addons")).json() as { id: string; badge: string }[];
	assert.deepEqual(list.map(a => [a.id, a.badge]), [["good-addon", "verified"]]);
});

test("index issue times always move forward", async () => {
	const { app } = setup();
	await ready(app);
	const a = (await index(app)).body.issued;
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN)).status, 200);
	assert.ok((await index(app)).body.issued > a);
});

test("a storm of changes can't push the index ahead of the clock", async () => {
	const { app, now } = setup();
	await ready(app);
	await hook(app, "installation", installation([{ id: 300, full_name: "dev/x" }]));
	for (let i = 0; i < 150; i++) {
		const r = { id: 100, full_name: `dev/good-addon-${i}`, owner: { id: 200 } };
		await hook(app, "repository", { action: "renamed", installation: { id: 5 }, repository: r });
	}
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN)).status, 200);
	for (let i = 0; i < 150; i++) {
		await hook(app, "repository", { action: "renamed", installation: { id: 5 }, repository: { id: 100, full_name: `dev/good-addon-${i}`, owner: { id: 200 } } });
	}
	assert.ok((await index(app)).body.issued <= Math.floor(now() / 1000) + 60);
});

test("no index before the Library is set up", async () => {
	const { app } = setup({ indexKey: undefined });
	assert.equal((await req(app, "GET", "/v1/index.json")).status, 503);
	assert.equal((await req(app, "GET", "/v1/library/addons")).status, 404, "the website reads this as not open yet");
});

test("approvals need the admin token and the right signatures", async () => {
	const { app } = setup();
	assert.equal((await req(app, "POST", "/v1/library/approvals", cert(LISTING, "listing"))).status, 403);
	assert.equal((await req(app, "POST", "/v1/library/approvals", cert(LISTING, "listing"), OPEN)).status, 403);
	assert.equal((await req(app, "POST", "/v1/library/approvals", cert(LISTING, "listing", OTHER), ADMIN)).status, 422);
	await ready(app);
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc({}, VERSION), ADMIN)).status, 422, "a version key can't list");
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc({}, INDEX), ADMIN)).status, 422, "nor can the index key");
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN)).status, 422, "not a newer revision");
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc({ id: "myriad-evil" }), ADMIN)).status, 422, "reserved id");
	assert.equal((await req(app, "POST", "/v1/library/approvals", { kind: "nonsense", doc: {} }, ADMIN)).status, 422);
});

test("versions need the right Library key, the developer, a GitHub download and one jar per version", async () => {
	const { app } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	await req(app, "POST", "/v1/library/approvals", listingDoc({ id: "closed-addon", repoId: 101, source: "closed", downloadRepoId: 102 }), ADMIN);
	const post = (doc: unknown) => req(app, "POST", "/v1/library/approvals", { kind: "version", doc }, ADMIN);
	assert.equal((await post(versionDoc("1.0.0", undefined, OTHER))).status, 422, "unknown key");
	assert.equal((await post(versionDoc("1.0.0", undefined, INDEX))).status, 422, "index key can't sign versions");
	assert.equal((await post(versionDoc("1.0.0", undefined, VERSION, OTHER))).status, 422, "not the developer");
	assert.equal((await post({ ...versionDoc("1.0.0"), url: "https://evil.example/x.jar" })).status, 422, "not GitHub");
	assert.equal((await post(versionDoc("1.0.0", undefined, VERSION, DEV, "closed-addon"))).status, 422, "version key on a closed listing");
	assert.equal((await post(versionDoc("1.0.0", undefined, LISTING, DEV, "closed-addon"))).status, 200, "listing key on a closed listing");
	assert.equal((await post(versionDoc("1.0.0"))).status, 200);
	assert.equal((await post(versionDoc("1.0.0"))).status, 200, "the same jar again is fine");
	assert.equal((await post(versionDoc("1.0.0", sha256Hex("other")))).status, 422, "another jar as the same version");
});

test("webhooks need GitHub's signature and each delivery counts once", async () => {
	const { app, library } = setup();
	assert.equal((await hook(app, "installation", installation([]), undefined, "wrong")).status, 401);
	const missing = await app.request("/v1/github/webhook", { method: "POST", headers: { "content-type": "application/json", "x-github-delivery": crypto.randomUUID() }, body: "{}" });
	assert.equal(missing.status, 401);
	const huge = await app.request("/v1/github/webhook", { method: "POST", headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) }, body: "x".repeat(2 * 1024 * 1024) });
	assert.equal(huge.status, 413);
	const guid = crypto.randomUUID();
	assert.equal((await hook(app, "installation", installation([{ id: 100, full_name: "dev/good-addon" }]), guid)).status, 202);
	assert.equal(library.store.repo(100)?.fullName, "dev/good-addon");
	const again = await hook(app, "installation", installation([{ id: 100, full_name: "dev/renamed" }]), guid);
	assert.equal((await again.json() as { seen?: boolean }).seen, true);
	assert.equal(library.store.repo(100)?.fullName, "dev/good-addon", "a replay changed nothing");
});

test("a release becomes a build; the open builder signs it in; the developer sees check runs", async () => {
	const { app, library, github } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	await hook(app, "installation", installation([{ id: 100, full_name: "dev/good-addon" }]));
	assert.equal((await hook(app, "release", released(100, "dev/good-addon", "v1.1.0"))).status, 202);
	assert.equal((await hook(app, "release", released(100, "dev/good-addon", "v1.1.0"))).status, 202);
	await library.tick();
	assert.deepEqual(github.dispatched, [{ repo: "MyriadClient/myriad-builder", submission: 1 }], "one build for one release");
	assert.match(github.checks[0]?.run.title ?? "", /^Queued/);

	assert.equal((await req(app, "GET", "/v1/library/builds/1")).status, 403);
	assert.equal((await req(app, "GET", "/v1/library/builds/1", undefined, CLOSED)).status, 404, "the closed builder can't see an open build");
	const spec = await (await req(app, "GET", "/v1/library/builds/1", undefined, OPEN)).json() as { tag: string; listing: { id: string } };
	assert.equal(spec.tag, "v1.1.0");
	assert.equal(spec.listing.id, "good-addon");
	assert.equal((await req(app, "POST", "/v1/library/builds/1/started", undefined, OPEN)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/builds/1/source-token", undefined, OPEN)).status, 403, "open builds get no tokens");

	const forged = await req(app, "POST", "/v1/library/builds/1/result", { outcome: "signed", version: versionDoc("1.1.0", undefined, OTHER) }, OPEN);
	assert.equal(forged.status, 422);
	assert.equal(library.store.submission(1)?.status, "failed");
});

test("a signed result lists the version and rebuilds the index", async () => {
	const { app, library } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	await hook(app, "installation", installation([{ id: 100, full_name: "dev/good-addon" }]));
	await hook(app, "release", released(100, "dev/good-addon", "v1.1.0"));
	await library.tick();
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
	const asset = "https://github.com/dev/good-addon/releases/download/v1.1.0/x-1.0.0.jar";
	const res = await req(app, "POST", "/v1/library/builds/1/result", { outcome: "signed", version: { ...versionDoc("1.1.0"), url: asset }, icon: png.toString("base64") }, OPEN);
	assert.equal(res.status, 200);
	assert.equal(library.store.submission(1)?.status, "signed");
	assert.equal((await index(app)).body.addons[0].versions[0].version, "1.1.0");
	assert.equal((await req(app, "GET", "/v1/library/addons/good-addon/icon.png")).headers.get("content-type"), "image/png");
	assert.equal((await req(app, "POST", "/v1/library/builds/1/result", { outcome: "failed" }, OPEN)).status, 404, "a finished build takes no more results");
});

test("a version's modules, changelog and icon reach the index as display info, cleaned", async () => {
	const { app, library } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	await hook(app, "installation", installation([{ id: 100, full_name: "dev/good-addon" }]));
	await hook(app, "release", released(100, "dev/good-addon", "v1.1.0"));
	await library.tick();
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
	const asset = "https://github.com/dev/good-addon/releases/download/v1.1.0/x-1.0.0.jar";
	const report = {
		modules: [{ name: "Kill Aura\uf00c", description: "Attacks targets.", tag: "Combat" }, "junk", { description: "nameless" }],
		changelog: "- Faster\r\n\n\n\n- Fixed\u0000 it",
	};
	const res = await req(app, "POST", "/v1/library/builds/1/result", { outcome: "signed", version: { ...versionDoc("1.1.0"), url: asset }, icon: png.toString("base64"), report }, OPEN);
	assert.equal(res.status, 200);
	const info = (await index(app)).body.addons[0].info;
	assert.equal(info.modules, undefined, "the details stay out of the signed index");
	assert.equal(info.moduleCount, 1);
	assert.equal(info.icon, createHash("sha256").update(png).digest("hex"));
	const details = await req(app, "GET", "/v1/library/addons/good-addon/details.json");
	const text = await details.text();
	assert.equal(info.details, createHash("sha256").update(text).digest("hex"), "the index names the details by their hash");
	const d = JSON.parse(text);
	assert.deepEqual(d.modules, [{ name: "Kill Aura", description: "Attacks targets.", tag: "Combat" }]);
	assert.equal(d.changelog, "- Faster\n\n- Fixed it");
	assert.equal(d.version, "1.1.0");
	const site = await (await req(app, "GET", "/v1/library/addons/good-addon")).json();
	assert.equal(site.modules.length, 1);
	assert.equal(site.changelog.version, "1.1.0");
});

test("a builder's result counts only for its own release", async () => {
	const { app, library } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	await req(app, "POST", "/v1/library/approvals", listingDoc({ id: "other-addon", repoId: 102, ownerId: 200 }), ADMIN);
	await hook(app, "release", released(100, "dev/good-addon", "v1.1.0"));
	await hook(app, "release", released(100, "dev/good-addon", "v1.2.0"));
	await library.tick();
	const at = (tag: string) => `https://github.com/dev/good-addon/releases/download/${tag}/x-1.0.0.jar`;
	const other = { ...versionDoc("1.1.0", undefined, VERSION, DEV, "other-addon"), url: at("v1.1.0") };
	assert.equal((await req(app, "POST", "/v1/library/builds/1/result", { outcome: "signed", version: other }, OPEN)).status, 422, "another listing's id");
	const elsewhere = { ...versionDoc("1.2.0"), url: at("v1.1.0") };
	assert.equal((await req(app, "POST", "/v1/library/builds/2/result", { outcome: "signed", version: elsewhere }, OPEN)).status, 422, "another release's jar");
	assert.equal(library.store.version("good-addon", "1.2.0"), undefined);
});

test("a repository that changes owner is paused, even when GitHub never said it was transferred", async () => {
	const { app, library } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	assert.equal((await index(app)).body.addons.length, 1);
	// The new owner installs the App: the repository is now theirs.
	await hook(app, "installation", { action: "created", installation: { id: 6, account: { id: 333, login: "new" } }, repositories: [{ id: 100, full_name: "new/good-addon" }] });
	assert.equal(library.store.listing("good-addon")?.paused, true);
	assert.equal((await index(app)).body.addons.length, 0);
	await hook(app, "release", { ...released(100, "new/good-addon", "v2.0.0"), installation: { id: 6 } });
	await library.tick();
	assert.equal(library.store.submission(1), undefined, "nothing is built for it");
});

test("the closed builder only reviews, and gets one short-lived token for one repository", async () => {
	const { app, library, github, advance } = setup();
	await ready(app);
	await hook(app, "installation", installation([{ id: 101, full_name: "dev/secret", private: true }]));
	await hook(app, "release", released(101, "dev/secret", "v1.0.0", true));
	await library.tick();
	assert.equal(github.dispatched.length, 0, "a new private addon waits for the maintainer");
	assert.equal(library.store.submission(1)?.status, "waiting");
	assert.equal((await req(app, "POST", "/v1/library/submissions/1/accept", undefined, OPEN)).status, 403);
	assert.equal((await req(app, "POST", "/v1/library/submissions/1/accept", undefined, ADMIN)).status, 200);
	await library.tick();
	assert.deepEqual(github.dispatched, [{ repo: "MyriadClient/myriad-builder-private", submission: 1 }]);

	const tok = await req(app, "POST", "/v1/library/builds/1/source-token", undefined, CLOSED);
	assert.equal(tok.status, 200);
	assert.deepEqual(github.tokens.at(-1), { installation: 5, scope: { repositoryIds: [101], permissions: { contents: "read" } } });
	assert.equal((await req(app, "POST", "/v1/library/builds/1/source-token", undefined, CLOSED)).status, 409, "only once");
	assert.equal((await req(app, "POST", "/v1/library/builds/1/result", { outcome: "signed", version: versionDoc("1.0.0") }, CLOSED)).status, 403, "the closed builder never signs");
	assert.equal((await req(app, "POST", "/v1/library/builds/1/result", { outcome: "review", reason: "new addon" }, CLOSED)).status, 200);
	assert.equal(library.store.submission(1)?.status, "review");

	await hook(app, "release", released(101, "dev/secret", "v1.0.1", true));
	await req(app, "POST", "/v1/library/submissions/2/accept", undefined, ADMIN);
	await library.tick();
	advance(16 * 60_000);
	assert.equal((await req(app, "POST", "/v1/library/builds/2/source-token", undefined, CLOSED)).status, 410, "too late");
});

test("a transferred repository pauses its listing and drops it from the index", async () => {
	const { app } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	await hook(app, "installation", installation([{ id: 100, full_name: "dev/good-addon" }]));
	assert.equal((await index(app)).body.addons.length, 1);
	await hook(app, "repository", { action: "transferred", installation: { id: 5 }, repository: { id: 100, full_name: "other/good-addon", owner: { id: 300 } } });
	assert.equal((await index(app)).body.addons.length, 0);
	assert.equal((await req(app, "GET", "/v1/library/addons/good-addon")).status, 404);
});

test("yanks need the listing key or the developer's; the online keys can't make one", async () => {
	const { app } = setup();
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	await req(app, "POST", "/v1/library/approvals", { kind: "version", doc: versionDoc("1.0.0") }, ADMIN);
	const y = { id: "good-addon", version: "1.0.0", sha256: sha256Hex("1.0.0") };
	const post = (by: ReturnType<typeof key>, token = ADMIN) => req(app, "POST", "/v1/library/approvals", { kind: "yank", doc: { ...y, signatures: [signWith(by, yankBytes(y))] } }, token);
	assert.equal((await post(LISTING, OPEN)).status, 403, "the maintainer's route");
	assert.equal((await post(INDEX)).status, 422, "not the index key");
	assert.equal((await post(VERSION)).status, 422, "nor the version key");
	assert.equal((await post(OTHER)).status, 422);
	assert.equal((await post(LISTING)).status, 200);
	assert.ok(signer(yankBytes(y), (await index(app)).body.addons[0].yanks[0].signatures, [LISTING.publicText]));
	assert.equal((await post(DEV)).status, 200, "a developer may yank their own release");
	assert.equal((await req(app, "POST", "/v1/library/yank", { id: "good-addon", version: "1.0.0" }, ADMIN)).status, 404, "no index-key yanks");
});

test("accepted findings need the listing key's signature, for that listing and revision", async () => {
	const { app, library } = setup();
	await ready(app);
	const doc = listingDoc();
	const found = ["process", "host:example.com"];
	assert.equal((await req(app, "POST", "/v1/library/approvals", { ...doc, doc: { ...doc.doc, accepted: found } }, ADMIN)).status, 422, "unsigned");
	const other = [signWith(LISTING, acceptedBytes("good-addon", 2, found))];
	assert.equal((await req(app, "POST", "/v1/library/approvals", { ...doc, doc: { ...doc.doc, accepted: found, acceptedSignatures: other } }, ADMIN)).status, 422, "another revision's");
	const good = [signWith(LISTING, acceptedBytes("good-addon", 1, found))];
	assert.equal((await req(app, "POST", "/v1/library/approvals", { ...doc, doc: { ...doc.doc, accepted: found, acceptedSignatures: good } }, ADMIN)).status, 200);
	assert.deepEqual(library.store.listing("good-addon")?.acceptedSigs, good);
});

test("Myriad's reserved ids are only for Myriad's own repositories", async () => {
	const { app, library } = setup();
	await ready(app);
	library.store.putRepo({ id: 500, installationId: 9, ownerId: MYRIAD_OWNER, fullName: "MyriadClient/myriad-essentials", private: false }, 1);
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc({ id: "myriad-essentials", repoId: 500, ownerId: MYRIAD_OWNER }), ADMIN)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/approvals", listingDoc({ id: "fabric-evil", repoId: 100 }), ADMIN)).status, 422);
});

test("too many releases from one installation are dropped", async () => {
	const { app, library } = setup({ submissionsPerDay: 2 });
	await hook(app, "installation", installation([{ id: 100, full_name: "dev/good-addon" }]));
	for (const tag of ["v1", "v2", "v3"]) await hook(app, "release", released(100, "dev/good-addon", tag));
	assert.equal(library.store.submissions(["queued"]).length, 2);
});

test("deploys are debounced", async () => {
	const { app, library } = setup({ deployHook: "https://example.invalid/hook" });
	await ready(app);
	await req(app, "POST", "/v1/library/approvals", listingDoc(), ADMIN);
	assert.equal(library.store.dueJobs(Number.MAX_SAFE_INTEGER).filter(j => j.kind === "deploy").length, 1);
});

test("one installation can't hold more than two builders at once", async () => {
	const { app, library, github } = setup();
	await ready(app);
	for (const tag of ["v1.0.0", "v1.0.1", "v1.0.2"]) await hook(app, "release", released(100, "dev/good-addon", tag));
	await library.tick();
	assert.equal(github.dispatched.length, 2);
	await req(app, "POST", "/v1/library/builds/1/result", { outcome: "failed", reason: "x" }, OPEN);
	await library.tick();
	assert.equal(github.dispatched.length, 3, "the third goes once one finishes");
});

// ---- accounts and invite-only addons -------------------------------------------------------------------------------

const PLAYER = { id: "0123456789abcdef0123456789abcdef", name: "Steve" };

/** Links PLAYER (Mojang says they joined) and returns the session token. */
async function signIn(app: App, mojang: FakeMojang, who = PLAYER) {
	const { nonce } = await (await req(app, "POST", "/v1/auth/minecraft/start")).json() as { nonce: string };
	mojang.joined.set(serverIdFor(nonce), who);
	const res = await req(app, "POST", "/v1/auth/minecraft/finish", { nonce, name: who.name, label: "Laptop" });
	assert.equal(res.status, 200);
	return (await res.json() as { token: string }).token;
}

/** An invite-only listing (closed source, private releases repository 103) with version 1.0.0 as `jar`. */
async function inviteOnly(app: App, library: ReturnType<typeof setup>["library"], jar: Buffer) {
	await ready(app);
	await hook(app, "installation", installation([{ id: 101, full_name: "dev/closed-addon", private: true }, { id: 103, full_name: "dev/secret-releases", private: true }]));
	const l = listingDoc({ id: "closed-addon", repoId: 101, source: "closed", downloadRepoId: 103 });
	assert.equal((await req(app, "POST", "/v1/library/approvals", { ...l, doc: { ...l.doc, access: "invite" } }, ADMIN)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/approvals", { kind: "version", doc: versionDoc("1.0.0", sha256Hex(jar), LISTING, DEV, "closed-addon") }, ADMIN)).status, 200);
	library.store.setVersionAsset("closed-addon", "1.0.0", 555);
}

let nonces = 0;
function invite(r: Partial<InviteRequest> & { action: InviteRequest["action"] }, at: number, by = DEV) {
	const request: InviteRequest = { id: "closed-addon", api: "https://api.myriadclient.dev", issued: Math.floor(at / 1000), nonce: `nonce-${String(nonces++).padStart(20, "0")}`, ...r };
	return { request, signatures: [signWith(by, inviteBytes(request))] };
}

test("the server id is Java's signed hex of the link hash, as Minecraft spells it", () => {
	// Minecraft's own examples of BigInteger(sha1(x)).toString(16).
	const javaHex = (x: string) => {
		const d = createHash("sha1").update(x).digest();
		let n = BigInt("0x" + d.toString("hex"));
		if (d[0]! & 0x80) n -= 1n << 160n;
		return n < 0n ? "-" + (-n).toString(16) : n.toString(16);
	};
	assert.equal(javaHex("Notch"), "4ed1f46bbe04bc756bcb17c0c7ce3e4632f06a48");
	assert.equal(javaHex("jeb_"), "-7c9d5b0044c130109a5d7b5fb5c317c02b4e28c1");
	assert.equal(serverIdFor("abc"), javaHex("myriad-link:abc"));
	// The same ids Myriad's core works out (its LibraryAccountTest pins them too).
	assert.equal(serverIdFor("abc"), "375f420c445c6c3ef27ef2e2d1867e64ffbf384e");
	assert.equal(serverIdFor("nonce-xyz"), "-6aebae44fe50d5f3f22011d471415ba00be48134");
});

test("linking needs Mojang to say the account joined, and each nonce works once", async () => {
	const { app, mojang, advance } = setup();
	const token = await signIn(app, mojang);
	const me = await req(app, "GET", "/v1/auth/session", undefined, token);
	assert.equal(me.status, 200);
	assert.equal((await me.json() as { name: string }).name, "Steve");

	const { nonce } = await (await req(app, "POST", "/v1/auth/minecraft/start")).json() as { nonce: string };
	assert.equal((await req(app, "POST", "/v1/auth/minecraft/finish", { nonce, name: "Steve" })).status, 401, "Mojang never heard of it");
	assert.equal((await req(app, "POST", "/v1/auth/minecraft/finish", { nonce, name: "Steve" })).status, 401, "a nonce works once, even after a failure");
	const late = await (await req(app, "POST", "/v1/auth/minecraft/start")).json() as { nonce: string };
	mojang.joined.set(serverIdFor(late.nonce), PLAYER);
	advance(3 * 60_000);
	assert.equal((await req(app, "POST", "/v1/auth/minecraft/finish", { nonce: late.nonce, name: "Steve" })).status, 401, "a stale nonce");
	const other = await (await req(app, "POST", "/v1/auth/minecraft/start")).json() as { nonce: string };
	mojang.joined.set(serverIdFor(other.nonce), PLAYER);
	assert.equal((await req(app, "POST", "/v1/auth/minecraft/finish", { nonce: other.nonce, name: "Alex" })).status, 401, "another name");
	mojang.down = true;
	const down = await (await req(app, "POST", "/v1/auth/minecraft/start")).json() as { nonce: string };
	assert.equal((await req(app, "POST", "/v1/auth/minecraft/finish", { nonce: down.nonce, name: "Steve" })).status, 503);

	assert.equal((await req(app, "DELETE", "/v1/auth/session", undefined, token)).status, 200);
	assert.equal((await req(app, "GET", "/v1/auth/session", undefined, token)).status, 401, "signed out");
	assert.equal((await req(app, "GET", "/v1/auth/session", undefined, "myr_s_" + "a".repeat(43))).status, 401, "a made-up token");
});

test("sessions expire unused and can be listed and ended from another", async () => {
	const { app, mojang, advance } = setup();
	const a = await signIn(app, mojang), b = await signIn(app, mojang);
	const list = await (await req(app, "GET", "/v1/auth/sessions", undefined, a)).json() as { id: number; current: boolean }[];
	assert.equal(list.length, 2);
	const theOther = list.find(x => !x.current)!;
	assert.equal((await req(app, "DELETE", `/v1/auth/sessions/${theOther.id}`, undefined, a)).status, 200);
	assert.equal((await req(app, "GET", "/v1/auth/session", undefined, b)).status, 401);
	advance(31 * 24 * 3600_000);
	assert.equal((await req(app, "GET", "/v1/auth/session", undefined, a)).status, 401, "30 days unused");
});

test("an invite-only listing's index entry has no download address", async () => {
	const { app, library } = setup();
	await inviteOnly(app, library, Buffer.alloc(1000, 7));
	const entry = (await index(app)).body.addons.find((a: { listing: { id: string } }) => a.listing.id === "closed-addon");
	assert.equal(entry.info.access, "invite");
	assert.equal(entry.versions[0].url, undefined);
	const detail = await (await req(app, "GET", "/v1/library/addons/closed-addon")).json() as { versions: { url?: string }[]; access: string };
	assert.equal(detail.access, "invite");
	assert.equal(detail.versions[0]!.url, undefined);
	const open = listingDoc();
	assert.equal((await req(app, "POST", "/v1/library/approvals", { ...open, doc: { ...open.doc, access: "invite" } }, ADMIN)).status, 422, "only closed listings");
});

test("developers manage invites with signed requests; codes are only ever hashes", async () => {
	const { app, library, now } = setup();
	await inviteOnly(app, library, Buffer.alloc(1000, 7));
	const code = "MYR-ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z2";
	const hash = sha256Hex(canonicalCode(code)!);
	const create = invite({ action: "create", codeSha256: hash, uses: 2, notAfter: Math.floor(now() / 1000) + 3600, label: "friends" }, now());
	const made = await req(app, "POST", "/v1/library/invites", create);
	assert.equal(made.status, 200);
	assert.equal((await req(app, "POST", "/v1/library/invites", create)).status, 409, "a request counts once");
	assert.equal((await req(app, "POST", "/v1/library/invites", invite({ action: "list" }, now(), OTHER))).status, 403, "a stranger's key");
	assert.equal((await req(app, "POST", "/v1/library/invites", invite({ action: "list" }, now() - 10 * 60_000))).status, 400, "a stale request");
	const tampered = invite({ action: "list" }, now());
	assert.equal((await req(app, "POST", "/v1/library/invites", { ...tampered, request: { ...tampered.request, id: "good-addon" } })).status, 404);
	const list = await (await req(app, "POST", "/v1/library/invites", invite({ action: "list" }, now()))).json() as { id: number; usesLeft: number; label: string }[];
	assert.deepEqual(list.map(i => [i.usesLeft, i.label]), [[2, "friends"]]);
	assert.ok(!JSON.stringify(library.store.db.prepare("SELECT * FROM library_invites").all()).includes("ABCDE"), "the code isn't stored");
});

test("redeeming grants access once per code use, and only the right account downloads the exact jar", async () => {
	const { app, library, mojang, github, now } = setup();
	const jar = Buffer.alloc(1000, 7);
	github.asset = jar;
	await inviteOnly(app, library, jar);
	const token = await signIn(app, mojang);
	assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token)).status, 403, "no grant yet");

	const code = "myr-abcde-fghij-klmno-pqrst-uvwxy-z2";
	const one = invite({ action: "create", codeSha256: sha256Hex(canonicalCode(code)!), uses: 1, notAfter: Math.floor(now() / 1000) + 3600 }, now());
	assert.equal((await req(app, "POST", "/v1/library/invites", one)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code: "myr-wrong-code" }, token)).status, 404);
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code })).status, 401, "needs a session");
	const ok = await req(app, "POST", "/v1/library/redeem", { code: code.toUpperCase().replaceAll("-", " ") }, token);
	assert.equal(ok.status, 200, "case and separators don't matter");
	assert.deepEqual(await (await req(app, "GET", "/v1/library/grants", undefined, token)).json(), ["closed-addon"]);

	const alex = await signIn(app, mojang, { id: "fedcba9876543210fedcba9876543210", name: "Alex" });
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code }, alex)).status, 404, "a single-use code is spent");

	const got = await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token);
	assert.equal(got.status, 200);
	assert.equal(got.headers.get("cache-control"), "no-store");
	assert.deepEqual(Buffer.from(await got.arrayBuffer()), jar);
	assert.deepEqual(github.assets.at(-1), { installation: 5, repoId: 103, repo: "dev/secret-releases", assetId: 555 });
	assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, alex)).status, 403, "another account");

	github.asset = Buffer.alloc(1000, 8);
	assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token)).status, 502, "not the listed jar");
	github.asset = jar;

	const revoke = invite({ action: "revoke-grant", uuid: PLAYER.id }, now());
	assert.equal((await req(app, "POST", "/v1/library/invites", revoke)).status, 200);
	assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token)).status, 403, "a revoked grant");

	// A revoke sticks: another live code doesn't bring the player back, only the developer does.
	const many = "myr-" + "E".repeat(27);
	await req(app, "POST", "/v1/library/invites", invite({ action: "create", codeSha256: sha256Hex(canonicalCode(many)!), uses: 20, notAfter: Math.floor(now() / 1000) + 3600 }, now()));
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code: many }, token)).status, 404, "a revoked player can't redeem back in");
	assert.equal((await req(app, "POST", "/v1/library/invites", invite({ action: "restore-grant", uuid: PLAYER.id }, now()))).status, 200);
	assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token)).status, 200, "restored by the developer");

	// A request signed for another server never counts here.
	assert.equal((await req(app, "POST", "/v1/library/invites", invite({ action: "list", api: "https://staging.example" }, now()))).status, 400);
});

test("redeeming is rate-limited per session", async () => {
	const { app, library, mojang } = setup();
	await inviteOnly(app, library, Buffer.alloc(1000, 7));
	const token = await signIn(app, mojang);
	for (let i = 0; i < 10; i++) assert.equal((await req(app, "POST", "/v1/library/redeem", { code: `myr-${"A".repeat(26)}${i % 8 + 2}` }, token)).status, 404);
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code: `myr-${"B".repeat(27)}` }, token)).status, 429);
});

test("an expired or revoked invite doesn't work", async () => {
	const { app, library, mojang, now, advance } = setup();
	await inviteOnly(app, library, Buffer.alloc(1000, 7));
	const token = await signIn(app, mojang);
	const a = `myr-${"C".repeat(27)}`, b = `myr-${"D".repeat(27)}`;
	await req(app, "POST", "/v1/library/invites", invite({ action: "create", codeSha256: sha256Hex(canonicalCode(a)!), uses: 5, notAfter: Math.floor(now() / 1000) + 60 }, now()));
	const made = await (await req(app, "POST", "/v1/library/invites", invite({ action: "create", codeSha256: sha256Hex(canonicalCode(b)!), uses: 5, notAfter: Math.floor(now() / 1000) + 3600 }, now()))).json() as { invite: number };
	await req(app, "POST", "/v1/library/invites", invite({ action: "revoke", invite: made.invite }, now()));
	advance(2 * 60_000);
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code: a }, token)).status, 404, "expired");
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code: b }, token)).status, 404, "revoked");
});

test("parallel downloads can't slip past the daily cap, and signing in again buys no more", async () => {
	const { app, library, mojang, github, now } = setup();
	const jar = Buffer.alloc(1000, 7);
	github.asset = jar;
	await inviteOnly(app, library, jar);
	const token = await signIn(app, mojang);
	const code = `myr-${"F".repeat(27)}`;
	await req(app, "POST", "/v1/library/invites", invite({ action: "create", codeSha256: sha256Hex(canonicalCode(code)!), uses: 1, notAfter: Math.floor(now() / 1000) + 3600 }, now()));
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code }, token)).status, 200);

	// Fifteen at once while GitHub is slow: one is fetched, the rest are turned away.
	let open!: () => void;
	github.assetGate = new Promise(r => open = r);
	const burst = Array.from({ length: 15 }, () => req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token));
	await new Promise(r => setTimeout(r, 20));
	open();
	const codes = (await Promise.all(burst)).map(r => r.status);
	assert.equal(codes.filter(c => c === 200).length, 1, codes.join(","));
	github.assetGate = undefined;

	// One at a time, ten a day per version, whichever session asks.
	for (let i = 1; i < 10; i++) assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token)).status, 200);
	assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, token)).status, 429);
	const again = await signIn(app, mojang);
	assert.equal((await req(app, "GET", "/v1/library/private/closed-addon/1.0.0", undefined, again)).status, 429, "a new session is the same player");

	// Only what reached the player is counted: the turned-away requests in the burst aren't.
	assert.equal((library.store.db.prepare("SELECT COUNT(*) AS n FROM library_downloads").get() as { n: number }).n, 10);
});

test("a private releases repository made public pauses its listing", async () => {
	const { app, library } = setup();
	await inviteOnly(app, library, Buffer.alloc(1000, 7));
	assert.equal((await req(app, "GET", "/v1/library/addons/closed-addon")).status, 200);
	await hook(app, "repository", { action: "publicized", installation: { id: 5 }, repository: { id: 103, full_name: "dev/secret-releases", private: false, owner: { id: 200 } } });
	assert.equal((await req(app, "GET", "/v1/library/addons/closed-addon")).status, 404);
});

test("developers can still revoke while their listing is paused", async () => {
	const { app, library, mojang, now } = setup();
	await inviteOnly(app, library, Buffer.alloc(1000, 7));
	const token = await signIn(app, mojang);
	const code = `myr-${"G".repeat(27)}`;
	await req(app, "POST", "/v1/library/invites", invite({ action: "create", codeSha256: sha256Hex(canonicalCode(code)!), uses: 1, notAfter: Math.floor(now() / 1000) + 3600 }, now()));
	assert.equal((await req(app, "POST", "/v1/library/redeem", { code }, token)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/listings/closed-addon/pause", undefined, ADMIN)).status, 200);
	assert.equal((await req(app, "POST", "/v1/library/invites", invite({ action: "revoke-grant", uuid: PLAYER.id }, now()))).status, 200);
	assert.equal(library.store.db.prepare("SELECT revoked FROM library_grants").get()!.revoked, 1);
});

test("a session ends 90 days after it was made, however much it's used", async () => {
	const { app, mojang, advance } = setup();
	const token = await signIn(app, mojang);
	for (let day = 0; day < 87; day += 2) {
		advance(2 * 24 * 3600_000);
		assert.equal((await req(app, "GET", "/v1/auth/session", undefined, token)).status, 200, `day ${day + 2}`);
	}
	advance(3 * 24 * 3600_000);
	assert.equal((await req(app, "GET", "/v1/auth/session", undefined, token)).status, 401);
});
