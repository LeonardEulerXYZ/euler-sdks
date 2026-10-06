import { getAddress, isAddress, type Address } from "viem";
import type { BuildQueryFn } from "../../utils/buildQuery.js";
import { applyBuildQuery } from "../../utils/buildQuery.js";

export type VaultAssessmentFamily = "evk" | "earn";
export type VaultFindingOutcome = "pass" | "fail" | "unknown" | "not_applicable";
export type VaultAssessmentConfigStatus =
	| "unverified" | "pending" | "verified" | "suspended" | "revoked";
export type VaultAssessmentChecksStatus = "positive" | "warning" | "negative" | null;
export type VaultAssessmentUnavailableReason = "chain-not-supported" | "v3-disabled";

export class VaultAssessmentUnavailableError extends Error {
	readonly code = "VAULT_ASSESSMENT_UNAVAILABLE";
	constructor(readonly reason: VaultAssessmentUnavailableReason) {
		super(`Vault assessments are unavailable: ${reason}`);
		this.name = "VaultAssessmentUnavailableError";
	}
}

export const isVaultAssessmentUnavailableError = (
	value: unknown,
	reason?: VaultAssessmentUnavailableReason,
): value is VaultAssessmentUnavailableError => {
	if (!isRecord(value)) return false;
	return value.code === "VAULT_ASSESSMENT_UNAVAILABLE" &&
		(value.reason === "chain-not-supported" || value.reason === "v3-disabled") &&
		(reason === undefined || value.reason === reason);
};

export interface VaultAssessmentFinding {
	key: string;
	outcome: VaultFindingOutcome;
	required: boolean;
	description: string;
	observed?: unknown;
	expected?: unknown;
	cause: { code: string; subject: string | null; summary: string; remedy: string | null } | null;
	exempted?: boolean;
}

export interface VaultAssessmentContext {
	findings: VaultAssessmentFinding[];
	[key: string]: unknown;
}

export interface VaultAssessment {
	chainId: number;
	vaultAddress: Address;
	family: VaultAssessmentFamily;
	configStatus: VaultAssessmentConfigStatus;
	checksStatus: VaultAssessmentChecksStatus;
	configReason: string | null;
	consistencyReason: string | null;
	configContext: VaultAssessmentContext | null;
	consistencyContext: VaultAssessmentContext | null;
	configLastCheckedAt: string | null;
	nextCheckAt: string | null;
	createdAt: string | null;
	assessed: boolean;
}

export interface VaultAssessmentServiceConfig {
	endpoint?: string;
	apiKey?: string;
	cacheMs?: number;
}

export interface IVaultAssessmentService {
	fetchVaultAssessment(
		chainId: number,
		address: Address,
		family: VaultAssessmentFamily,
		options?: { fresh?: boolean },
	): Promise<VaultAssessment | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown, field: string): string | null => {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new Error(`Invalid vault assessment ${field}`);
	return value;
};
const parseFinding = (value: unknown): VaultAssessmentFinding => {
	if (!isRecord(value) || typeof value.key !== "string" ||
		!(["pass", "fail", "unknown", "not_applicable"] as unknown[]).includes(value.outcome) ||
		typeof value.required !== "boolean" || typeof value.description !== "string") {
		throw new Error("Invalid vault assessment finding");
	}
	let cause: VaultAssessmentFinding["cause"] = null;
	if (value.cause !== null && value.cause !== undefined) {
		if (!isRecord(value.cause) || typeof value.cause.code !== "string" ||
			(value.cause.subject !== null && typeof value.cause.subject !== "string") || typeof value.cause.summary !== "string" ||
			(value.cause.remedy !== null && value.cause.remedy !== undefined && typeof value.cause.remedy !== "string")) {
			throw new Error("Invalid vault assessment finding cause");
		}
		cause = {
			code: value.cause.code,
			subject: value.cause.subject,
			summary: value.cause.summary,
			remedy: value.cause.remedy ?? null,
		};
	}
	if (value.exempted !== undefined && typeof value.exempted !== "boolean") {
		throw new Error("Invalid vault assessment finding exemption");
	}
	return {
		key: value.key,
		outcome: value.outcome as VaultFindingOutcome,
		required: value.required,
		description: value.description,
		...(value.observed !== undefined ? { observed: value.observed } : {}),
		...(value.expected !== undefined ? { expected: value.expected } : {}),
		cause,
		...(value.exempted !== undefined ? { exempted: value.exempted as boolean } : {}),
	};
};
const parseContext = (value: unknown): VaultAssessmentContext | null => {
	if (value === null || value === undefined) return null;
	if (!isRecord(value) || !Array.isArray(value.findings)) {
		throw new Error("Invalid vault assessment context");
	}
	return { ...value, findings: value.findings.map(parseFinding) };
};

export const parseVaultAssessment = (
	value: unknown,
	chainId: number,
	address: Address,
	family: VaultAssessmentFamily,
): VaultAssessment => {
	if (!isRecord(value) || value.chainId !== chainId ||
		typeof value.vaultAddress !== "string" || !isAddress(value.vaultAddress) ||
		getAddress(value.vaultAddress) !== getAddress(address)) {
		throw new Error("Vault assessment identity mismatch");
	}
	if (!(["unverified", "pending", "verified", "suspended", "revoked"] as unknown[]).includes(value.configStatus)) {
		throw new Error("Invalid vault assessment configStatus");
	}
	if (value.checksStatus !== null && value.checksStatus !== undefined &&
		!(["positive", "warning", "negative"] as unknown[]).includes(value.checksStatus)) {
		throw new Error("Invalid vault assessment checksStatus");
	}
	const configContext = parseContext(value.configContext);
	const consistencyContext = parseContext(value.consistencyContext);
	const configLastCheckedAt = optionalString(value.configLastCheckedAt, "configLastCheckedAt");
	const configStatus = value.configStatus as VaultAssessmentConfigStatus;
	return {
		chainId,
		vaultAddress: getAddress(value.vaultAddress),
		family,
		configStatus,
		checksStatus: (value.checksStatus ?? null) as VaultAssessmentChecksStatus,
		configReason: optionalString(value.configReason, "configReason"),
		consistencyReason: optionalString(value.consistencyReason, "consistencyReason"),
		configContext,
		consistencyContext,
		configLastCheckedAt,
		nextCheckAt: optionalString(value.nextCheckAt, "nextCheckAt"),
		createdAt: optionalString(value.createdAt, "createdAt"),
		assessed: configContext !== null || configLastCheckedAt !== null ||
			configStatus === "pending" || configStatus === "revoked",
	};
};

export class VaultAssessmentService implements IVaultAssessmentService {
	private readonly cache = new Map<string, { expiresAt: number; value: VaultAssessment | undefined }>();
	constructor(
		private readonly config: VaultAssessmentServiceConfig = {},
		buildQuery?: BuildQueryFn,
	) {
		if (buildQuery) applyBuildQuery(this, buildQuery);
	}

	private requestV3VaultAssessment = async (
		chainId: number,
		address: Address,
		family: VaultAssessmentFamily,
	): Promise<unknown | undefined> => {
		const endpoint = (this.config.endpoint ?? "https://v3.euler.finance").replace(/\/+$/, "");
		const response = await fetch(`${endpoint}/v3/${family}/vaults/${chainId}/${getAddress(address)}/assessment`, {
			headers: {
				Accept: "application/json",
				...(this.config.apiKey ? { "X-API-Key": this.config.apiKey } : {}),
			},
		});
		if (response.status === 404) {
			const body: unknown = await response.json().catch(() => undefined);
			if (isRecord(body) && isRecord(body.error) && body.error.code === "CHAIN_NOT_SUPPORTED") {
				throw new VaultAssessmentUnavailableError("chain-not-supported");
			}
			return undefined;
		}
		if (!response.ok) throw new Error(`Vault assessment request failed: ${response.status} ${response.statusText}`);
		const body: unknown = await response.json();
		if (!isRecord(body) || !Object.hasOwn(body, "data")) throw new Error("Invalid vault assessment response");
		return body.data;
	};

	queryV3VaultAssessment = async (
		chainId: number,
		address: Address,
		family: VaultAssessmentFamily,
	): Promise<unknown | undefined> => this.requestV3VaultAssessment(chainId, address, family);

	async fetchVaultAssessment(
		chainId: number,
		address: Address,
		family: VaultAssessmentFamily,
		options: { fresh?: boolean } = {},
	): Promise<VaultAssessment | undefined> {
		if (family !== "evk" && family !== "earn") throw new Error("Invalid vault assessment family");
		if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid vault assessment chainId");
		const normalized = getAddress(address);
		const key = `${family}:${chainId}:${normalized.toLowerCase()}`;
		const hit = this.cache.get(key);
		if (!options.fresh && hit && hit.expiresAt > Date.now()) return hit.value;
		const raw = options.fresh
			? await this.requestV3VaultAssessment(chainId, normalized, family)
			: await this.queryV3VaultAssessment(chainId, normalized, family);
		const value = raw === undefined ? undefined : parseVaultAssessment(raw, chainId, normalized, family);
		this.cache.set(key, { expiresAt: Date.now() + (this.config.cacheMs ?? 5 * 60_000), value });
		return value;
	}
}

export class UnavailableVaultAssessmentService implements IVaultAssessmentService {
	constructor(readonly reason: VaultAssessmentUnavailableReason = "v3-disabled") {}
	async fetchVaultAssessment(): Promise<undefined> {
		throw new VaultAssessmentUnavailableError(this.reason);
	}
}
