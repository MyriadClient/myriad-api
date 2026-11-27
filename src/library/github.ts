import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** What the Library needs from GitHub. The real one talks to api.github.com; tests use a fake. */
export interface GitHub {
	/** A token for one installation, limited to `repositoryIds` and `permissions` when given (an hour at most). */
	installationToken(installationId: number, scope?: { repositoryIds: number[]; permissions: Record<string, "read" | "write"> }): Promise<string>;
	/** The commit a tag points at, in a repository the installation can see. */
	commitOf(installationId: number, repoFullName: string, tag: string): Promise<string>;
	createCheckRun(installationId: number, repoFullName: string, headSha: string, run: CheckRun): Promise<number>;
	updateCheckRun(installationId: number, repoFullName: string, id: number, run: CheckRun): Promise<void>;
	/** Starts the builder workflow for one submission (with the private dispatch App). */
	dispatch(builderRepo: string, submission: number): Promise<void>;
}

export interface CheckRun {
	status: "queued" | "in_progress" | "completed";
	conclusion?: "success" | "failure" | "neutral" | "action_required" | "cancelled";
	title: string;
	summary: string;
	/** Longer details under the summary (GitHub shows them below it). */
	text?: string;
}

export const CHECK_NAME = "Myriad Library";
const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const TAG = /^[A-Za-z0-9._+-]{1,100}$/;

/** Whether `signature` (the `X-Hub-Signature-256` header) is GitHub's HMAC of `body` with `secret`. Constant time. */
export function webhookSignatureValid(secret: string, body: Buffer, signature: string | undefined): boolean {
	if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
	const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
	const given = Buffer.from(signature);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A GitHub App's JWT (RS256), good for nine minutes. */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
	const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const head = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })}`;
	return `${head}.${createSign("RSA-SHA256").update(head).sign(privateKeyPem).toString("base64url")}`;
}

export interface GitHubConfig {
	appId: string;
	appKey: string;
	dispatchAppId: string;
	dispatchAppKey: string;
	dispatchInstallationId: number;
}

export class RealGitHub implements GitHub {
	private readonly config: GitHubConfig;

	constructor(config: GitHubConfig) {
		this.config = config;
	}

	private async call(token: string, method: string, path: string, body?: unknown, bearer = "token"): Promise<unknown> {
		const res = await fetch(`${API}${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `${bearer} ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "myriad-library",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]}: HTTP ${res.status}`);
		return text ? JSON.parse(text) : undefined;
	}

	async installationToken(installationId: number, scope?: { repositoryIds: number[]; permissions: Record<string, "read" | "write"> }): Promise<string> {
		return this.tokenFor(this.config.appId, this.config.appKey, installationId, scope);
	}

	private async tokenFor(appId: string, key: string, installationId: number, scope?: { repositoryIds: number[]; permissions: Record<string, "read" | "write"> }): Promise<string> {
		if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("not an installation");
		const body = scope ? { repository_ids: scope.repositoryIds, permissions: scope.permissions } : undefined;
		const r = await this.call(appJwt(appId, key), "POST", `/app/installations/${installationId}/access_tokens`, body, "Bearer") as { token?: unknown };
		if (typeof r?.token !== "string") throw new Error("GitHub gave no token");
		return r.token;
	}

	async commitOf(installationId: number, repoFullName: string, tag: string): Promise<string> {
		if (!REPO.test(repoFullName) || !TAG.test(tag)) throw new Error("odd repository or tag");
		const token = await this.installationToken(installationId);
		const r = await this.call(token, "GET", `/repos/${repoFullName}/commits/${encodeURIComponent(tag)}`) as { sha?: unknown };
		if (typeof r?.sha !== "string" || !/^[0-9a-f]{40}$/.test(r.sha)) throw new Error("GitHub gave no commit");
		return r.sha;
	}

	async createCheckRun(installationId: number, repoFullName: string, headSha: string, run: CheckRun): Promise<number> {
		if (!REPO.test(repoFullName) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error("odd repository or commit");
		const token = await this.installationToken(installationId);
		const r = await this.call(token, "POST", `/repos/${repoFullName}/check-runs`, { name: CHECK_NAME, head_sha: headSha, ...checkBody(run) }) as { id?: unknown };
		if (typeof r?.id !== "number") throw new Error("GitHub gave no check run");
		return r.id;
	}

	async updateCheckRun(installationId: number, repoFullName: string, id: number, run: CheckRun): Promise<void> {
		if (!REPO.test(repoFullName)) throw new Error("odd repository");
		const token = await this.installationToken(installationId);
		await this.call(token, "PATCH", `/repos/${repoFullName}/check-runs/${id}`, checkBody(run));
	}

	async dispatch(builderRepo: string, submission: number): Promise<void> {
		if (!REPO.test(builderRepo)) throw new Error("odd builder repository");
		const token = await this.tokenFor(this.config.dispatchAppId, this.config.dispatchAppKey, this.config.dispatchInstallationId);
		await this.call(token, "POST", `/repos/${builderRepo}/actions/workflows/build.yml/dispatches`, { ref: "main", inputs: { submission: String(submission) } });
	}
}

function checkBody(run: CheckRun) {
	return {
		status: run.status,
		...(run.status === "completed" ? { conclusion: run.conclusion ?? "neutral" } : {}),
		output: { title: run.title.slice(0, 200), summary: run.summary.slice(0, 65000), ...(run.text ? { text: run.text.slice(0, 65000) } : {}) },
	};
}
