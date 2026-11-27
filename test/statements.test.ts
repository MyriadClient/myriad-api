import assert from "node:assert/strict";
import { test } from "node:test";
import {
	InvalidStatement, keyCertBytes, keyId, listingBytes, privateKey, revocationsBytes, signer, signWith, snapshotBytes, verify, versionBytes, yankBytes,
} from "../src/library/statements.ts";

// The Gradle plugin's test key (seed of 32 bytes of 9) and signatures it made, pinned in its LibraryStatementsTest and
// checked by core's LibraryIndexTest: the API must spell every statement the same way.
const K = "ed25519:_RckOFqgx1tk-3jNYC-h2ZH96_drE8WO1wLqyDXp9hg";
const B = "b".repeat(64), A = "a".repeat(64), C = "c".repeat(40), D = "d".repeat(64);

test("statements are spelled as core spells them", () => {
	assert.equal(listingBytes({ id: "my-addon", revision: 2, repoId: 10, ownerId: 20, source: "closed", downloadRepoId: 30, build: B, provides: ["b-lib", "a-lib", "b-lib"], keys: [K, K] }).toString(),
		`myriad-library-listing:1\nid=my-addon\nrevision=2\nrepo-id=10\nowner-id=20\nsource=closed\ndownload-repo-id=30\nbuild=${B}\nprovides=a-lib,b-lib\nkey=${K}\n`);
	assert.equal(versionBytes({ id: "my-addon", version: "1.2.0", size: 5, sha256: A, commit: C }).toString(),
		`myriad-library-version:1\nid=my-addon\nversion=1.2.0\nsize=5\nsha256=${A}\ncommit=${C}\n`);
	assert.equal(keyCertBytes({ key: K, role: "index", notAfter: 1900000000 }).toString(), `myriad-library-key:1\nkey=${K}\nrole=index\nnot-after=1900000000\n`);
	assert.equal(yankBytes({ id: "my-addon", version: "1.2.0", sha256: A }).toString(), `myriad-library-yank:1\nid=my-addon\nversion=1.2.0\nsha256=${A}\n`);
	assert.equal(snapshotBytes({ issued: 10, expires: 20, bodySha256: D }).toString(), `myriad-library-snapshot:1\nissued=10\nexpires=20\nbody-sha256=${D}\n`);
	assert.equal(revocationsBytes({ seq: 3, keys: [K] }).toString(), `myriad-library-revocations:1\nseq=3\nkey=${K}\n`);
});

test("the plugin's signatures verify here", () => {
	assert.equal(keyId(K), "dbc298251c51321b");
	const listing = listingBytes({ id: "my-addon", revision: 2, repoId: 10, ownerId: 20, source: "closed", downloadRepoId: 30, build: B, provides: ["b-lib", "a-lib"], keys: [K] });
	assert.ok(verify(listing, "UKOyo-L7WrULQzwNWR7gh_r1cqT2nVb-CphCUScreYrbzvdcoE7Xd_WsRUqyOTs3fDo3ZhsIWIyvNJO3-_j6CQ", K));
	const version = versionBytes({ id: "my-addon", version: "1.2.0", size: 5, sha256: A, commit: C });
	assert.ok(verify(version, "EqKGIz1yA_h80CrETT4If0YmNi9drQIVGi-5HIF3du8jA8lYr7Yg4KeT1iqs0MObHUWue1h_NdRlDuuAaoejDg", K));
	assert.ok(verify(snapshotBytes({ issued: 10, expires: 20, bodySha256: D }), "Qag6eUIp_3kyxcg5ISbvMT9704QLmz6DXcAdMhLh1L7PcwlwqeVu38_iV1g6ZJzONo9SVgrhJt25h72aIwRTDw", K));
	// One kind's signature never passes as another's.
	assert.ok(!verify(version, "UKOyo-L7WrULQzwNWR7gh_r1cqT2nVb-CphCUScreYrbzvdcoE7Xd_WsRUqyOTs3fDo3ZhsIWIyvNJO3-_j6CQ", K));
});

test("signing with a private key gives what the plugin gives", () => {
	const key = privateKey(`ed25519-private:${Buffer.alloc(32, 9).toString("base64url")}`);
	assert.equal(key.publicText, K);
	const version = versionBytes({ id: "my-addon", version: "1.2.0", size: 5, sha256: A, commit: C });
	assert.deepEqual(signWith(key, version), { key: "dbc298251c51321b", sig: "EqKGIz1yA_h80CrETT4If0YmNi9drQIVGi-5HIF3du8jA8lYr7Yg4KeT1iqs0MObHUWue1h_NdRlDuuAaoejDg" });
	assert.equal(signer(version, [{ key: "x", sig: "nonsense" }, signWith(key, version)], [K]), K);
	assert.equal(signer(version, [signWith(key, version)], []), undefined);
});

test("malleated signatures are refused", () => {
	const version = versionBytes({ id: "my-addon", version: "1.2.0", size: 5, sha256: A, commit: C });
	const raw = Buffer.from("EqKGIz1yA_h80CrETT4If0YmNi9drQIVGi-5HIF3du8jA8lYr7Yg4KeT1iqs0MObHUWue1h_NdRlDuuAaoejDg", "base64url");
	// S + L: the same signature to a lax verifier.
	let s = 0n;
	for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(raw[i]!);
	s += 2n ** 252n + 27742317777372353535851937790883648493n;
	const m = Buffer.from(raw);
	for (let i = 32; i < 64; i++) { m[i] = Number(s & 0xffn); s >>= 8n; }
	assert.ok(!verify(version, m.toString("base64url"), K));
});

test("odd fields are refused", () => {
	const bad = (f: () => unknown) => assert.throws(f, InvalidStatement);
	bad(() => versionBytes({ id: "my-addon", version: "1.0\nid=evil", size: 5, sha256: A, commit: C }));
	bad(() => versionBytes({ id: "My-addon", version: "1.0", size: 5, sha256: A, commit: C }));
	bad(() => versionBytes({ id: "my-addon", version: "1.0", size: 1.5, sha256: A, commit: C }));
	bad(() => versionBytes({ id: "my-addon", version: "1.0", size: 5, sha256: A, commit: "abc" }));
	bad(() => listingBytes({ id: "x-addon", revision: 1, repoId: 1, ownerId: 1, source: "open", downloadRepoId: 3, build: B, provides: [], keys: [K] }));
	bad(() => listingBytes({ id: "x-addon", revision: 1, repoId: 1, ownerId: 1, source: "closed", downloadRepoId: 0, build: B, provides: [], keys: [K] }));
	bad(() => listingBytes({ id: "x-addon", revision: 1, repoId: 1, ownerId: 1, source: "open", downloadRepoId: 0, build: B, provides: ["x-addon"], keys: [K] }));
	bad(() => listingBytes({ id: "x-addon", revision: 1, repoId: 1, ownerId: 1, source: "open", downloadRepoId: 0, build: B, provides: [], keys: [] }));
	bad(() => keyCertBytes({ key: K, role: "listing", notAfter: 5 }));
	bad(() => keyCertBytes({ key: `${K}=`, role: "listing", notAfter: 0 }));
	bad(() => snapshotBytes({ issued: 20, expires: 10, bodySha256: D }));
});

test("invite requests are spelled as the Gradle plugin spells them", async () => {
	const { inviteBytes } = await import("../src/library/statements.ts");
	assert.equal(inviteBytes({ id: "closed-addon", action: "create", api: "https://api.myriadclient.dev", issued: 1800000000, nonce: "nonce-00000000000000000000", codeSha256: "a".repeat(64), uses: 2, notAfter: 1800003600, label: "friends" }).toString("ascii"),
		"myriad-library-invite:1\nid=closed-addon\naction=create\napi=https://api.myriadclient.dev\nissued=1800000000\nnonce=nonce-00000000000000000000\ncode-sha256=" + "a".repeat(64) + "\nuses=2\nnot-after=1800003600\nlabel=friends\n");
	assert.equal(inviteBytes({ id: "closed-addon", action: "revoke-grant", api: "https://api.myriadclient.dev", issued: 1800000000, nonce: "nonce-00000000000000000001", uuid: "0123456789abcdef0123456789abcdef" }).toString("ascii"),
		"myriad-library-invite:1\nid=closed-addon\naction=revoke-grant\napi=https://api.myriadclient.dev\nissued=1800000000\nnonce=nonce-00000000000000000001\nuuid=0123456789abcdef0123456789abcdef\n");
	assert.equal(inviteBytes({ id: "closed-addon", action: "revoke-all", api: "https://api.myriadclient.dev", issued: 1800000000, nonce: "nonce-00000000000000000003", invite: 7 }).toString("ascii"),
		"myriad-library-invite:1\nid=closed-addon\naction=revoke-all\napi=https://api.myriadclient.dev\nissued=1800000000\nnonce=nonce-00000000000000000003\ninvite=7\n");
	assert.equal(inviteBytes({ id: "closed-addon", action: "show", api: "https://api.myriadclient.dev", issued: 1800000000, nonce: "nonce-00000000000000000004", show: ["changelog", "repo"] }).toString("ascii"),
		"myriad-library-invite:1\nid=closed-addon\naction=show\napi=https://api.myriadclient.dev\nissued=1800000000\nnonce=nonce-00000000000000000004\nshow=changelog,repo\n");
});
