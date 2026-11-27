import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/**
 * What the API needs from GitHub: only to start a workflow in one of Myriad's own builder repositories, with the Dispatch
 * App (installed on those two repositories alone). The API holds no key to developers' repositories: the Library App's
 * key lives in the private builder, which reads releases and posts check runs itself and reports here. Tests use a fake.
 */
export interface GitHub {
	/** Starts `workflow` on `builderRepo`'s main branch with string `inputs`. */
	dispatch(builderRepo: string, workflow: Workflow, inputs: Record<string, string>): Promise<void>;
}

/** The builder workflows the API starts: a build for one submission, or posting the check runs waiting to be posted. */
export type Workflow = "build.yml" | "checks.yml";

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

	async dispatch(builderRepo: string, workflow: Workflow, inputs: Record<string, string>): Promise<void> {
		if (!REPO.test(builderRepo) || !["build.yml", "checks.yml"].includes(workflow)) throw new Error("odd builder repository or workflow");
		const id = this.config.dispatchInstallationId;
		if (!Number.isSafeInteger(id) || id <= 0) throw new Error("not an installation");
		const r = await this.call(appJwt(this.config.dispatchAppId, this.config.dispatchAppKey), "POST", `/app/installations/${id}/access_tokens`, undefined, "Bearer") as { token?: unknown };
		if (typeof r?.token !== "string") throw new Error("GitHub gave no token");
		await this.call(r.token, "POST", `/repos/${builderRepo}/actions/workflows/${workflow}/dispatches`, { ref: "main", inputs });
	}
}

/** A check run as GitHub's API takes it, within GitHub's limits: what the builder posts for the API. */
export function checkBody(run: CheckRun) {
	return {
		status: run.status,
		...(run.status === "completed" ? { conclusion: run.conclusion ?? "neutral" } : {}),
		output: { title: run.title.slice(0, 200), summary: run.summary.slice(0, 65000), ...(run.text ? { text: run.text.slice(0, 65000) } : {}) },
	};
}
