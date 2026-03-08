/**
 * Kilo Code Provider Extension
 *
 * Provides access to Kilo Code's free AI models via OAuth authentication.
 * Supports device code flow for secure browser-based authentication.
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/kilo.ts
 *   # Then /login kilo to authenticate via OAuth
 *
 * Free Models Available:
 *   - CoreThink (78K context)
 *   - MiniMax M2.5 (204K context)
 *   - Giga Potato (256K context, image support)
 *   - Trinity Large Preview (131K context)
 *   - Grok Code Fast 1 Optimized (256K context)
 *   - Aurora Alpha (128K context)
 *   - OpenRouter Models (200K context, image support)
 *   - Step 3.5 Flash (256K context)
 */

import {
	type Api,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_ID = "kilo";
const BASE_URL = "https://api.kilo.ai/api";
const POLL_INTERVAL_MS = 3000;

// Default headers sent with all requests
const DEFAULT_HEADERS: Record<string, string> = {
	"HTTP-Referer": "https://kilocode.ai",
	"X-Title": "Kilo Code",
	"X-KiloCode-Version": "pi-extension",
	"X-KiloCode-EditorName": "pi",
	"User-Agent": "Kilo-Code/pi-extension",
};

// Optional environment variables that can be passed as headers
const OPTIONAL_ENV_HEADERS: Array<{ env: string; header: string }> = [
	{ env: "KILOCODE_ORGANIZATION_ID", header: "X-KiloCode-OrganizationId" },
	{ env: "KILOCODE_PROJECT_ID", header: "X-KiloCode-ProjectId" },
	{ env: "KILOCODE_MODE", header: "X-KiloCode-Mode" },
	{ env: "KILOCODE_TASK_ID", header: "X-KiloCode-TaskId" },
	{ env: "KILOCODE_MACHINE_ID", header: "X-KiloCode-MachineId" },
	{ env: "KILOCODE_TESTER", header: "X-KILOCODE-TESTER" },
];

// Free models available through Kilo Code
const FREE_MODELS = [
	{
		id: "corethink:free",
		name: "CoreThink",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 78000,
		maxTokens: 8192,
	},
	{
		id: "minimax/minimax-m2.5:free",
		name: "MiniMax M2.5",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
	},
	{
		id: "giga-potato",
		name: "Giga Potato",
		reasoning: false,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 32000,
	},
	{
		id: "arcee-ai/trinity-large-preview:free",
		name: "Trinity Large Preview",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131000,
		maxTokens: 8192,
	},
	{
		id: "x-ai/grok-code-fast-1:optimized:free",
		name: "Grok Code Fast 1 Optimized",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 10000,
	},
	{
		id: "openrouter/aurora-alpha",
		name: "Aurora Alpha",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 50000,
	},
	{
		id: "openrouter/free",
		name: "OpenRouter Models",
		reasoning: false,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "stepfun/step-3.5-flash:free",
		name: "Step 3.5 Flash",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 256000,
	},
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract base URL from Kilo token payload
 * Returns development URL if token indicates dev environment
 */
function getKiloBaseUriFromToken(kilocodeToken?: string): string {
	if (kilocodeToken) {
		try {
			const payloadString = kilocodeToken.split(".")[1];
			if (!payloadString) return "https://api.kilo.ai";

			const payloadJson =
				typeof atob !== "undefined"
					? atob(payloadString)
					: Buffer.from(payloadString, "base64").toString();
			const payload = JSON.parse(payloadJson);

			if (payload.env === "development") return "http://localhost:3000";
		} catch {
			return "https://api.kilo.ai";
		}
	}
	return "https://api.kilo.ai";
}

/**
 * Get Kilo API URL, replacing host with token-derived base URL
 */
function getKiloUrlFromToken(targetUrl: string, kilocodeToken?: string): string {
	const baseUrl = getKiloBaseUriFromToken(kilocodeToken);
	const target = new URL(targetUrl);
	const { protocol, host } = new URL(baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`);
	Object.assign(target, { protocol, host });
	return target.toString();
}

/**
 * Build request headers with default and optional environment headers
 */
function buildHeaders(): Record<string, string> {
	const headers: Record<string, string> = { ...DEFAULT_HEADERS };

	for (const entry of OPTIONAL_ENV_HEADERS) {
		const value = process.env[entry.env];
		if (value && value.trim()) {
			headers[entry.header] = value.trim();
		}
	}

	return headers;
}

// =============================================================================
// OAuth Authentication
// =============================================================================

/**
 * Initiate Kilo Code OAuth device code flow
 * Polls for token approval with configurable interval
 */
async function loginKilocode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	// Initiate device authorization
	const initiateResponse = await fetch("https://api.kilo.ai/api/device-auth/codes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	});

	if (!initiateResponse.ok) {
		if (initiateResponse.status === 429) {
			throw new Error("Too many pending authorization requests. Please try again later.");
		}
		throw new Error(`Failed to initiate device authorization: ${initiateResponse.status}`);
	}

	const initiateData = (await initiateResponse.json()) as {
		code: string;
		verificationUrl: string;
		expiresIn: number;
	};

	// Show verification URL and code to user
	if (callbacks.onDeviceCode) {
		callbacks.onDeviceCode({
			userCode: initiateData.code,
			verificationUri: initiateData.verificationUrl,
		});
	} else {
		callbacks.onAuth({
			url: initiateData.verificationUrl,
			instructions: `Enter code: ${initiateData.code}`,
		});
	}

	// Poll for token approval
	const deadline = Date.now() + initiateData.expiresIn * 1000;
	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

		const pollResponse = await fetch(
			`https://api.kilo.ai/api/device-auth/codes/${initiateData.code}`,
		);

		if (!pollResponse) continue;
		if (pollResponse.status === 202) continue; // Still pending

		if (pollResponse.status === 403) {
			throw new Error("Authorization was denied");
		}
		if (pollResponse.status === 410) {
			throw new Error("Authorization code expired. Please try again.");
		}
		if (!pollResponse.ok) {
			throw new Error(`Failed to poll device authorization: ${pollResponse.status}`);
		}

		const pollData = (await pollResponse.json()) as { status: string; token?: string };

		if (pollData.status === "approved" && pollData.token) {
			return {
				refresh: "",
				access: pollData.token,
				expires: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
			};
		}

		if (pollData.status === "denied") {
			throw new Error("Authorization was denied");
		}
		if (pollData.status === "expired") {
			throw new Error("Authorization code expired. Please try again.");
		}
	}

	throw new Error("Authentication timed out. Please try again.");
}

/**
 * Token refresh handler - Kilo tokens don't expire
 */
async function refreshKilocodeToken(_credentials: OAuthCredentials): Promise<OAuthCredentials> {
	throw new Error("Kilo tokens do not expire. Please re-login if you have issues.");
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: `${BASE_URL}/openrouter/`,
		apiKey: "KILO_TOKEN",
		api: "openai-completions",
		headers: buildHeaders(),
		models: FREE_MODELS,
		oauth: {
			name: "Kilo",
			login: loginKilocode,
			refreshToken: refreshKilocodeToken,
			getApiKey: (cred) => cred.access,
		},
		streamSimple: streamSimpleOpenAICompletions,
	});
}
