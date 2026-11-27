import assert from "node:assert/strict";
import test from "node:test";
import { listedCheck, queuedCheck, refusedCheck, reviewCheck } from "../src/library/checks.ts";

const report = {
	id: "good-addon", version: "1.2.0", minecraft: "~26.3", commit: "a".repeat(40), sha256: "b".repeat(64), size: 81920,
	modules: [{ name: "Kill Aura" }], changelog: "- Faster",
	findings: [{ id: "network:com/example/Net", where: ["com/example/Net"] }, { id: "host:example.com", where: ["com/example/Net"] }],
};

test("each state says where the release is and what happens next", () => {
	const q = queuedCheck("v1.2.0", false, false);
	assert.equal(q.status, "queued");
	assert.match(q.summary, /✅ Release received .*⏳ Built from source/);
	const listed = listedCheck("v1.2.0", "good-addon", "1.2.0", report, "123");
	assert.equal(listed.conclusion, "success");
	assert.match(listed.summary, /is in the Myriad Library/);
	assert.match(listed.summary, /\| Modules \| 1: what Browse lists \|/);
	assert.match(listed.text!, /actions\/runs\/123/);
	const review = reviewCheck("v1.2.0", "its build logic changed since it was listed; new finding: host:example.com", report);
	assert.equal(review.conclusion, "neutral");
	assert.match(review.summary, /👀 Reviewed/);
	assert.match(review.summary, /build logic changed/);
	assert.match(review.text!, /\| 🆕 \| \*\*host\*\* \| `example\.com` \| names this host in its code \|/);
	assert.match(review.text!, /\| ✓ \| \*\*network\*\* \| `com\/example\/Net` \|/);
	const refused = refusedCheck("v1.2.0", "The released jar isn't what its tagged source builds.", report);
	assert.equal(refused.conclusion, "failure");
	assert.match(refused.summary, /❌ Checked/);
	assert.match(refused.summary, /clean checkout/);
});

test("what a developer wrote never renders as Markdown", () => {
	const evil = { ...report, findings: [{ id: "host:x`](https://evil.example)[`", where: ["a|b<script>"] }] };
	const r = reviewCheck("v1`[x](https://evil.example)", "new finding: [click](https://evil.example)", evil);
	// Inline code renders nothing inside it: outside code spans, no link and no HTML may appear.
	const outsideCode = (t: string) => t.replace(/`[^`]*`/g, "");
	for (const out of [r.summary, r.text!, r.title]) {
		assert.doesNotMatch(outsideCode(out), /\]\(https:\/\/evil/, "no links from developer text");
		assert.doesNotMatch(outsideCode(out), /<script>/);
	}
	const f = refusedCheck("v1", "[x](https://evil.example) | broken", undefined, "build");
	assert.doesNotMatch(outsideCode(f.summary), /\]\(https:\/\/evil/);
});
