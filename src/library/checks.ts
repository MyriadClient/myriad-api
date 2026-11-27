/*
 * The "Myriad Library" check run a developer sees on their release's commit, as it moves along: queued, building, then
 * listed, waiting for review, or not listed. Each says where the release is (a progress line), what happens next or what
 * to change, and, once built, what the builder found: the jar, its modules, and every finding with what it means.
 *
 * Everything here that came from a developer (tags, findings, reasons, module names) is shown as code or cleaned text,
 * never as Markdown, so a release can't put links or formatting into its own check.
 */
import type { CheckRun } from "./github.ts";

const DOCS = "https://myriadclient.dev/docs/develop/library/";
const SITE = "https://myriadclient.dev/library/";
const OPEN_BUILDER = "https://github.com/MyriadClient/myriad-builder/actions/runs/";

type Step = "received" | "build" | "checks" | "review" | "listed";
const STEPS: [Step, string][] = [["received", "Release received"], ["build", "Built from source"], ["checks", "Checked"], ["review", "Reviewed"], ["listed", "Listed"]];

/** One line of steps: done ✅, the one under way ⏳ (👀 for a person's review), a failed one ❌, the rest ◻️. */
function progress(done: Step[], now?: Step, failed?: Step, skip: Step[] = []): string {
	return STEPS.filter(([s]) => !skip.includes(s)).map(([s, label]) => {
		const mark = failed === s ? "❌" : done.includes(s) ? "✅" : now === s ? (s === "review" ? "👀" : "⏳") : "◻️";
		return `${mark} ${label}`;
	}).join(" &nbsp;→&nbsp; ");
}

/** Developer text as inline code: backticks can't close it, nothing in it renders. */
function code(v: unknown, max = 120): string {
	const s = String(v ?? "").replace(/[\u0000-\u001f\u007f`]/g, "").slice(0, max);
	return s ? "`" + s + "`" : "`?`";
}

/** Developer text as plain words in a table cell: no Markdown, no pipes, no line breaks. */
function plain(v: unknown, max = 200): string {
	return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\`*_{}[\]()#+!|<>~]/g, "").slice(0, max).trim();
}

/** What each finding means, for the developer. */
const MEANING: Record<string, string> = {
	classloader: "defines classes at run time (its own class loader, `defineClass`, hidden classes)",
	unsafe: "uses `sun.misc.Unsafe`",
	process: "starts programs",
	"native-load": "loads native code",
	"native-file": "carries a native library",
	network: "opens connections itself (sockets, HTTP clients, Minecraft's connection)",
	host: "names this host in its code",
	reflection: "looks up or calls code by name at run time",
	instrument: "uses Java agents or script engines",
	desktop: "opens files or links outside the game",
	jndi: "makes JNDI lookups",
	deserialization: "deserializes Java objects",
	"myriad-internals": "uses Myriad's internal `dev.myriadclient.impl` packages, which can change in any release",
	nested: "carries a jar inside its jar",
	"hidden-class": "has a class file hidden among its resources",
	"multi-release": "is a multi-release jar (different classes per Java version)",
	obfuscated: "looks obfuscated: obfuscated jars aren't listed",
	unexplained: "has a class no source file in the repository could have made",
	account: "reaches for the player's account (the session token, Mojang's session service, account files): read on every release",
	"mixin-network": "has a mixin into the game's connection, packets or login",
	"unreadable-class": "has a class file the builder couldn't read",
	"too-many-findings": "has more findings than the builder passes on: a person reads the full list",
};

/** A class path cut to its last three parts (`essentials/modules/combat/AutoDisconnect` → `modules/combat/AutoDisconnect`). */
function shortClass(s: string): string {
	const parts = s.split("/");
	return parts.length > 3 && !s.includes(".") ? "…/" + parts.slice(-3).join("/") : s;
}

function kindOf(id: string): string {
	const i = id.indexOf(":");
	return i < 0 ? id : id.slice(0, i);
}

type Finding = { id: string; where: string[] };

function findingsOf(report: Record<string, unknown> | null | undefined): Finding[] {
	const list = Array.isArray(report?.findings) ? report!.findings as unknown[] : [];
	return list.flatMap(f => {
		const o = f && typeof f === "object" ? f as Record<string, unknown> : {};
		return typeof o.id === "string" ? [{ id: o.id, where: Array.isArray(o.where) ? o.where.filter((w): w is string => typeof w === "string") : [] }] : [];
	});
}

/** The builder's reasons (`a; b; c`), one per line. */
function reasons(text: string | null | undefined): string[] {
	return String(text ?? "").split(/;\s*/).map(r => r.trim()).filter(Boolean).slice(0, 40);
}

/** The release in a table: what was built, from where, and what it adds. */
function facts(report: Record<string, unknown> | null | undefined, tag: string): string {
	const r = report ?? {};
	const rows: [string, string][] = [["Tag", code(tag)]];
	if (r.id) rows.push(["Addon", code(r.id)]);
	if (r.version) rows.push(["Version", code(r.version)]);
	if (typeof r.minecraft === "string" && r.minecraft) rows.push(["Minecraft", code(r.minecraft)]);
	if (typeof r.commit === "string" && /^[0-9a-f]{40}$/.test(r.commit)) rows.push(["Commit", code(r.commit.slice(0, 12))]);
	if (typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256)) rows.push(["Jar SHA-256", code(r.sha256)]);
	if (typeof r.size === "number") rows.push(["Size", `${Math.max(1, Math.round(r.size / 1024))} KB`]);
	const modules = Array.isArray(r.modules) ? r.modules.length : 0;
	rows.push(["Modules", modules ? `${modules}: what Browse lists` : "none found"]);
	rows.push(["Changelog", typeof r.changelog === "string" && r.changelog ? "found: shown as what's new" : "none: add a `## <version>` section to `CHANGELOG.md`"]);
	// The first row is the table's head, so there's no empty header row.
	const [head, ...rest] = rows;
	return `| ${head![0]} | ${head![1]} |\n|---|---|\n` + rest.map(([k, v]) => `| ${k} | ${v} |`).join("\n");
}

/** Every finding, what it means, where, and whether it's new to this listing. */
function findingsTable(report: Record<string, unknown> | null | undefined, newOnes: Set<string>): string {
	const list = findingsOf(report);
	if (!list.length) return "The builder found nothing that needs explaining.";
	const rows = list.slice(0, 60).map(f => {
		const kind = kindOf(f.id);
		const status = f.id === "obfuscated" ? "⛔" : kind === "account" || newOnes.has(f.id) ? "🆕" : "✓";
		// Per-class findings carry their class; a host its name; the rest say where they were found.
		const detail = f.id.includes(":") ? f.id.slice(kind.length + 1) : f.where[0] ?? "";
		return `| ${status} | **${plain(kind, 40)}** | ${detail ? code(shortClass(detail), 90) : ""} | ${MEANING[kind] ?? "see the docs"} |`;
	});
	const more = list.length > 60 ? `\n\n…and ${list.length - 60} more (the maintainer sees them all).` : "";
	return "| | Finding | In | What it means |\n|:-:|---|---|---|\n" + rows.join("\n") + more
		+ "\n\n🆕 needs a look this release &nbsp;·&nbsp; ✓ accepted for this addon before &nbsp;·&nbsp; ⛔ never listed";
}

/** What to change for a refusal, by what the refusal says. */
function fixFor(reason: string): string {
	const r = reason.toLowerCase();
	if (r.includes("isn't what its tagged source builds")) {
		return "Build the jar from the tagged commit in a clean checkout (`./gradlew build`) and attach that jar. Myriad's Gradle plugin makes the build reproducible; anything built from other changes won't match.";
	}
	if (r.includes(".sig") || r.includes("jar and its .sig")) return "Attach both the jar and its `.sig` to the release (`./gradlew signAddon` makes the `.sig`).";
	if (r.includes("signed") || r.includes("key")) {
		return "Sign the release with your developer key (`./gradlew signAddon`), and keep that key's public half in `fabric.mod.json` under `custom.myriad.keys`, as your listing has it.";
	}
	if (r.includes("already") && (r.includes("listed") || r.includes("library"))) return "That version is already in the Library with another jar. Release a new version number instead.";
	if (r.includes("template")) return "`fabric.mod.json` may use only `${version}`, `${myriad_version}` and `${minecraft_version}`: remove any other `$` or `<%`.";
	if (r.includes("didn't build")) return "Make sure `./gradlew jar` builds on JDK 25 from a clean checkout of the tag.";
	if (r.includes("obfuscated")) return "Release the jar unobfuscated: the Library doesn't list obfuscated jars.";
	if (r.includes("symlink")) return "Remove symbolic links from the repository.";
	return "Fix what it says above and publish a new release.";
}

const footer = (extra = "") => `\n\n---\n${extra}[How the Library checks releases](${DOCS}) · [The check's states](${DOCS}#the-check-on-your-release)`;

// ---- each state ---------------------------------------------------------------------------------------------------

export function queuedCheck(tag: string, closed: boolean, waitingForMaintainer: boolean): CheckRun {
	if (waitingForMaintainer) {
		return {
			status: "queued", title: `Waiting for Myriad: ${plain(tag, 100)}`,
			summary: `${progress(["received"], "review", undefined, ["build", "checks"])}\n\n### A new closed-source addon\n\nThe Myriad maintainer accepts a new closed-source addon before it's built. You'll see this check move on once it's accepted; there's nothing to do meanwhile.${footer()}`,
		};
	}
	return {
		status: "queued", title: `Queued: ${plain(tag, 100)}`,
		summary: `${progress(["received"], "build")}\n\n### Waiting for Myriad's builder\n\n${closed
			? "Myriad's private builder will fetch your source once, build it and check the release."
			: "Myriad's builder will build your tagged source in the open and check the released jar is exactly that build."} This usually takes a few minutes.${footer()}`,
	};
}

export function buildingCheck(tag: string, closed: boolean): CheckRun {
	return {
		status: "in_progress", title: `Building ${plain(tag, 100)}`,
		summary: `${progress(["received"], "build")}\n\n### Building and checking\n\n${closed ? "The private builder is" : "The builder is"} building your release from its tagged source, then reading the jar (without running it): what it adds, and anything it should explain.${footer()}`,
	};
}

export function listedCheck(tag: string, id: string, version: string, report: Record<string, unknown> | null | undefined, runId?: string): CheckRun {
	const run = runId && /^\d{1,20}$/.test(runId) ? `[The builder's run](${OPEN_BUILDER}${runId}) · ` : "";
	return {
		status: "completed", conclusion: "success", title: `Listed: ${plain(id, 64)} ${plain(version, 64)}`,
		summary: `${progress(["received", "build", "checks", "review", "listed"])}\n\n### ✅ ${code(id, 64)} ${code(version, 64)} is in the Myriad Library\n\nPlayers get it the next time Browse or their update check reads the Library, and it appears on [its Library page](${SITE}${encodeURIComponent(id)}/) within a few minutes. Players who installed it from the Library update to it through the Library.\n\n### The release\n\n${facts(report, tag)}`,
		text: `### What the builder found\n\n${findingsTable(report, new Set())}${footer(run)}`,
	};
}

export function reviewCheck(tag: string, reason: string | null | undefined, report: Record<string, unknown> | null | undefined, runId?: string): CheckRun {
	const why = reasons(reason);
	const newOnes = new Set(why.filter(r => r.startsWith("new finding: ")).map(r => r.slice("new finding: ".length)));
	const lines = why.map(r => {
		if (r.startsWith("new finding: ")) return `- 🆕 A new finding: ${code(r.slice(13), 100)}`;
		if (r.startsWith("needs a look every release: ")) return `- 👀 Read on every release: ${code(r.slice(28), 100)}`;
		if (r.includes("build logic changed")) return "- 🔧 Its **build logic changed** since it was listed. The maintainer approves the new build logic once; later releases with it are signed on their own.";
		if (r.includes("provides changed")) return "- 📦 What the jar **provides** changed since it was listed.";
		if (r.includes("closed-source")) return "- 🔒 It's **closed source**: every version is read by the maintainer.";
		if (r.includes("new addon")) return "- ✨ It's a **new addon**: the maintainer approves it once.";
		return `- ${plain(r, 300)}`;
	});
	const run = runId && /^\d{1,20}$/.test(runId) ? `[The builder's run](${OPEN_BUILDER}${runId}) · ` : "";
	return {
		status: "completed", conclusion: "neutral", title: `Waiting for review: ${plain(tag, 100)}`,
		summary: `${progress(["received", "build", "checks"], "review")}\n\n### 👀 A person will look at this release\n\nIt built and passed the automatic checks; these need the Myriad maintainer:\n\n${lines.join("\n") || "- The maintainer will look at this release."}\n\nThere's nothing to do unless the maintainer asks. This check turns green when it's listed.\n\n### The release\n\n${facts(report, tag)}`,
		text: `### What the builder found\n\n${findingsTable(report, newOnes)}${footer(run)}`,
	};
}

/** Not listed. {@code at}: the step it stopped at. */
export function refusedCheck(tag: string, reason: string, report: Record<string, unknown> | null | undefined, at: Step = "checks", runId?: string): CheckRun {
	const done: Step[] = at === "build" ? ["received"] : at === "checks" ? ["received", "build"] : ["received", "build", "checks"];
	const run = runId && /^\d{1,20}$/.test(runId) ? `[The builder's run](${OPEN_BUILDER}${runId}) · ` : "";
	const clean = plain(reason.replace(/^Refused:\s*/, ""), 500);
	const built = !!report && Object.keys(report).length > 0;
	const summary = `${progress(done, undefined, at)}\n\n### ❌ Not listed\n\n> ${clean || "The release couldn't be listed."}\n\n**What to do:** ${fixFor(clean)}`
		+ (built ? `\n\n### The release\n\n${facts(report, tag)}` : footer());
	return {
		status: "completed", conclusion: "failure", title: `Not listed: ${plain(tag, 100)}`, summary,
		...(built ? { text: `### What the builder found\n\n${findingsTable(report, new Set())}${footer(run)}` } : {}),
	};
}

export function approvedCheck(tag: string): CheckRun {
	return {
		status: "completed", conclusion: "success", title: `Listed: ${plain(tag, 100)}`,
		summary: `${progress(["received", "build", "checks", "review", "listed"])}\n\n### ✅ Approved into the Myriad Library\n\nThe Myriad maintainer approved this release. Players get it the next time Browse or their update check reads the Library.${footer()}`,
	};
}
