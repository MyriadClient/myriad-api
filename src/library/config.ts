import type { GitHubConfig } from "./github.ts";
import { ROOT_KEYS } from "./rules.ts";

/**
 * The Library's settings. Every part is off until its settings are given, so the API runs as before without them:
 * no index key, no index; no webhook secret, no webhooks; no tokens, no builder or maintainer routes. Tokens are given
 * as SHA-256 hashes (hex), so the server never holds them.
 */
export interface LibraryConfig {
	/** `ed25519-private:...`: signs the index. */
	indexKey?: string;
	adminTokenSha256?: string;
	builderOpenTokenSha256?: string;
	builderClosedTokenSha256?: string;
	webhookSecret?: string;
	github?: GitHubConfig;
	builderOpenRepo: string;
	builderClosedRepo: string;
	/** GitHub's number for the MyriadClient organisation: its repositories may use Myriad's reserved ids. */
	myriadOwnerId: number;
	deployHook?: string;
	deployToken?: string;
	rootKeys: string[];
	/** Releases one installation may submit per day. */
	submissionsPerDay: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function libraryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LibraryConfig {
	const hash = (v: string | undefined) => (v && HEX64.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined);
	const pem = (v: string | undefined) => v?.replace(/\\n/g, "\n");
	const appId = env.GITHUB_APP_ID, appKey = pem(env.GITHUB_APP_PRIVATE_KEY);
	const dAppId = env.GITHUB_DISPATCH_APP_ID, dKey = pem(env.GITHUB_DISPATCH_PRIVATE_KEY), dInst = Number(env.GITHUB_DISPATCH_INSTALLATION_ID);
	return {
		indexKey: env.LIBRARY_INDEX_KEY || undefined,
		adminTokenSha256: hash(env.LIBRARY_ADMIN_TOKEN_SHA256),
		builderOpenTokenSha256: hash(env.LIBRARY_BUILDER_OPEN_TOKEN_SHA256),
		builderClosedTokenSha256: hash(env.LIBRARY_BUILDER_CLOSED_TOKEN_SHA256),
		webhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
		github: appId && appKey && dAppId && dKey && Number.isSafeInteger(dInst) && dInst > 0
			? { appId, appKey, dispatchAppId: dAppId, dispatchAppKey: dKey, dispatchInstallationId: dInst } : undefined,
		builderOpenRepo: env.LIBRARY_BUILDER_OPEN_REPO ?? "MyriadClient/myriad-builder",
		builderClosedRepo: env.LIBRARY_BUILDER_CLOSED_REPO ?? "MyriadClient/myriad-builder-private",
		myriadOwnerId: Number(env.MYRIAD_OWNER_ID) || 0,
		deployHook: env.WEBSITE_DEPLOY_HOOK || undefined,
		deployToken: env.WEBSITE_DEPLOY_TOKEN || undefined,
		rootKeys: ROOT_KEYS,
		submissionsPerDay: Number(env.LIBRARY_SUBMISSIONS_PER_DAY) || 20,
	};
}
