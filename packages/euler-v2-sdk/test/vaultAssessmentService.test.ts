import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import {
	VaultAssessmentService,
	VaultAssessmentUnavailableError,
	UnavailableVaultAssessmentService,
} from "../src/services/vaultAssessmentService/index.js";

const ADDRESS = getAddress("0x0000000000000000000000000000000000000001");
const OTHER = getAddress("0x0000000000000000000000000000000000000002");
const finding = (overrides: Record<string, unknown> = {}) => ({
	key: "oracle.liability-quote",
	outcome: "fail",
	required: false,
	description: "Oracle quote failed",
	cause: {
		code: "quote-reverted",
		subject: ADDRESS,
		summary: "The oracle quote reverted",
		remedy: null,
	},
	...overrides,
});
const assessment = (overrides: Record<string, unknown> = {}) => ({
	chainId: 1,
	vaultAddress: ADDRESS,
	configStatus: "verified",
	checksStatus: "warning",
	configReason: null,
	consistencyReason: null,
	configContext: { findings: [finding()] },
	consistencyContext: { findings: [finding({ key: "governance.curator-registered", outcome: "pass" })] },
	configLastCheckedAt: "2026-09-29T12:00:00.000Z",
	nextCheckAt: null,
	createdAt: "2026-09-28T12:00:00.000Z",
	...overrides,
});
const response = (body: unknown, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	statusText: status === 200 ? "OK" : "Error",
	json: async () => body,
}) as Response;

afterEach(() => vi.restoreAllMocks());

describe("VaultAssessmentService", () => {
	it("parses EVK and Earn layers, keeping scheduled findings", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(response({ data: assessment() }))
			.mockResolvedValueOnce(response({ data: assessment({
				consistencyContext: { findings: [finding({ key: "scheduled.strategy.add", observed: { validAt: "2026-10-01T00:00:00.000Z" } })] },
			}) }));
		const service = new VaultAssessmentService({ endpoint: "https://example.com/api/internal/" });
		const evk = await service.fetchVaultAssessment(1, ADDRESS, "evk");
		const earn = await service.fetchVaultAssessment(1, ADDRESS, "earn");
		expect(evk?.assessed).toBe(true);
		expect(evk?.configContext?.findings[0]?.cause?.summary).toBe("The oracle quote reverted");
		expect(earn?.consistencyContext?.findings[0]?.key).toBe("scheduled.strategy.add");
		expect(fetchSpy.mock.calls.map(call => call[0])).toEqual([
			`https://example.com/api/internal/v3/evk/vaults/1/${ADDRESS}/assessment`,
			`https://example.com/api/internal/v3/earn/vaults/1/${ADDRESS}/assessment`,
		]);
	});

	it("distinguishes unassessed synthetic rows", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ data: assessment({
			configStatus: "unverified", configContext: null, consistencyContext: null,
			configLastCheckedAt: null, createdAt: null,
		}) }));
		expect((await new VaultAssessmentService().fetchVaultAssessment(1, ADDRESS, "evk"))?.assessed).toBe(false);
	});

	it("accepts a nullable cause subject from V3", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ data: assessment({
			configContext: { findings: [finding({
				cause: { code: "interest-rate-model-unset", subject: null, summary: "No interest rate model", remedy: "set-an-interest-rate-model" },
			})] },
		}) }));
		expect((await new VaultAssessmentService().fetchVaultAssessment(1, ADDRESS, "evk"))
			?.configContext?.findings[0]?.cause?.subject).toBeNull();
	});

	it("separates missing rows, unsupported chains and server failure", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(response({ error: { code: "NOT_FOUND" } }, 404))
			.mockResolvedValueOnce(response({ error: { code: "CHAIN_NOT_SUPPORTED" } }, 404))
			.mockResolvedValueOnce(response({ error: { code: "FAILED" } }, 503));
		const service = new VaultAssessmentService();
		expect(await service.fetchVaultAssessment(1, ADDRESS, "evk")).toBeUndefined();
		await expect(service.fetchVaultAssessment(1, ADDRESS, "evk", { fresh: true }))
			.rejects.toBeInstanceOf(VaultAssessmentUnavailableError);
		await expect(service.fetchVaultAssessment(1, ADDRESS, "evk", { fresh: true }))
			.rejects.toThrow("503");
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("caches by family, chain and address while fresh bypasses it", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ data: assessment() }));
		const service = new VaultAssessmentService();
		await service.fetchVaultAssessment(1, ADDRESS, "evk");
		await service.fetchVaultAssessment(1, ADDRESS, "evk");
		await service.fetchVaultAssessment(1, ADDRESS, "evk", { fresh: true });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it.each([
		assessment({ vaultAddress: OTHER }),
		assessment({ checksStatus: "maybe" }),
		assessment({ configContext: { findings: [finding({ outcome: "maybe" })] } }),
		assessment({ consistencyContext: { findings: [finding({ cause: { code: "bad" } })] } }),
	])("rejects malformed or mismatched assessment %#", async (payload) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ data: payload }));
		await expect(new VaultAssessmentService().fetchVaultAssessment(1, ADDRESS, "evk")).rejects.toThrow();
	});

	it("has an explicit disabled capability", async () => {
		await expect(new UnavailableVaultAssessmentService().fetchVaultAssessment())
			.rejects.toMatchObject({ reason: "v3-disabled" });
	});
});
