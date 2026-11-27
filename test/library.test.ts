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
import {
	acceptedBytes, keyCertBytes, listingBytes, privateKey, releaseBytes, sha256Hex, signer, signWith, snapshotBytes, versionBytes, yankBytes, type Listing,
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
	const library = createLibrary(store.db, config, github, 1, now);
	const app = createApp(store, base, now, library);
	return { app, library, github, store, advance: (ms: number) => { clock += ms; }, now };
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
