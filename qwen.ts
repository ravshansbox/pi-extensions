/**
 * Qwen Provider Extension
 *
 * Provides access to Qwen models via OAuth authentication with chat.qwen.ai.
 * Uses device code flow with PKCE for secure browser-based authentication.
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions
 *   # Then /login qwen to authenticate via OAuth
 *
 * Models supported:
 *   - qwen3.5-plus (reasoning, text)
 *   - qwen3-coder-plus (text only)
 *   - qwen3-coder-next (text only)
 *   - qwen3-max-2026-01-23 (reasoning, text)
 *   - glm-4.7 (reasoning, text)
 *   - glm-5 (reasoning, text)
 *   - MiniMax-M2.5 (reasoning, text)
 *   - kimi-k2.5 (reasoning, text)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";

// =============================================================================
// Constants
// =============================================================================

// OAuth Endpoints
const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;

// OAuth Client Configuration
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
const QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_POLL_INTERVAL_MS = 2000;

// API Base URLs (China and Global regions)
const QWEN_CODE_CHINA_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
const QWEN_CODE_GLOBAL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";

// =============================================================================
// PKCE Helpers
// =============================================================================

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return { verifier, challenge };
}

// =============================================================================
// OAuth Types
// =============================================================================

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	token_type: string;
	expires_in: number;
	resource_url?: string;
}

// =============================================================================
// OAuth Implementation
// =============================================================================

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function startDeviceFlow(): Promise<{ deviceCode: DeviceCodeResponse; verifier: string }> {
	const { verifier, challenge } = await generatePKCE();

	const body = new URLSearchParams({
		client_id: QWEN_OAUTH_CLIENT_ID,
		scope: QWEN_OAUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	const requestId = globalThis.crypto?.randomUUID?.();
	if (requestId) headers["x-request-id"] = requestId;

	const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
		method: "POST",
		headers,
		body: body.toString(),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Device code request failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as DeviceCodeResponse;

	if (!data.device_code || !data.user_code || !data.verification_uri) {
		throw new Error("Invalid device code response: missing required fields");
	}

	return { deviceCode: data, verifier };
}

async function pollForToken(
	deviceCode: string,
	verifier: string,
	intervalSeconds: number | undefined,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const deadline = Date.now() + expiresIn * 1000;
	const resolvedIntervalSeconds =
		typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds > 0
			? intervalSeconds
			: QWEN_POLL_INTERVAL_MS / 1000;
	let intervalMs = Math.max(1000, Math.floor(resolvedIntervalSeconds * 1000));

	const handleTokenError = async (error: string, description?: string): Promise<boolean> => {
		switch (error) {
			case "authorization_pending":
				await abortableSleep(intervalMs, signal);
				return true;
			case "slow_down":
				intervalMs = Math.min(intervalMs + 5000, 10000);
				await abortableSleep(intervalMs, signal);
				return true;
			case "expired_token":
				throw new Error("Device code expired. Please restart authentication.");
			case "access_denied":
				throw new Error("Authorization denied by user.");
			default:
				throw new Error(`Token request failed: ${error} - ${description || ""}`);
		}
	};

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const body = new URLSearchParams({
			grant_type: QWEN_OAUTH_GRANT_TYPE,
			client_id: QWEN_OAUTH_CLIENT_ID,
			device_code: deviceCode,
			code_verifier: verifier,
		});

		const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: body.toString(),
		});

		const responseText = await response.text();
		let data: (TokenResponse & { error?: string; error_description?: string }) | null = null;
		if (responseText) {
			try {
				data = JSON.parse(responseText) as TokenResponse & { error?: string; error_description?: string };
			} catch {
				data = null;
			}
		}

		const error = data?.error;
		const errorDescription = data?.error_description;

		if (!response.ok) {
			if (error && (await handleTokenError(error, errorDescription))) {
				continue;
			}
			throw new Error(`Token request failed: ${response.status} ${response.statusText}. Response: ${responseText}`);
		}

		if (data?.access_token) {
			return data;
		}

		if (error && (await handleTokenError(error, errorDescription))) {
			continue;
		}

		throw new Error("Token request failed: missing access token in response");
	}

	throw new Error("Authentication timed out. Please try again.");
}

async function loginQwen(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { deviceCode, verifier } = await startDeviceFlow();

	// Show verification URL and user code to user
	const authUrl = deviceCode.verification_uri_complete || deviceCode.verification_uri;
	const instructions = deviceCode.verification_uri_complete
		? undefined // Code is already embedded in the URL
		: `Enter code: ${deviceCode.user_code}`;
	callbacks.onAuth({ url: authUrl, instructions });

	// Poll for token
	const tokenResponse = await pollForToken(
		deviceCode.device_code,
		verifier,
		deviceCode.interval,
		deviceCode.expires_in,
		callbacks.signal,
	);

	// Calculate expiry with 5-minute buffer
	const expiresAt = Date.now() + tokenResponse.expires_in * 1000 - 5 * 60 * 1000;

	return {
		refresh: tokenResponse.refresh_token || "",
		access: tokenResponse.access_token,
		expires: expiresAt,
		enterpriseUrl: tokenResponse.resource_url,
	};
}

async function refreshQwenToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: credentials.refresh,
		client_id: QWEN_OAUTH_CLIENT_ID,
	});

	const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: body.toString(),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Token refresh failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as TokenResponse;

	if (!data.access_token) {
		throw new Error("Token refresh failed: no access token in response");
	}

	const expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;

	return {
		refresh: data.refresh_token || credentials.refresh,
		access: data.access_token,
		expires: expiresAt,
		enterpriseUrl: data.resource_url ?? credentials.enterpriseUrl,
	};
}

function getQwenBaseUrl(resourceUrl?: string): string {
	if (!resourceUrl) {
		return QWEN_CODE_GLOBAL_BASE_URL;
	}

	let url = resourceUrl.startsWith("http") ? resourceUrl : `https://${resourceUrl}`;
	if (!url.endsWith("/v1")) {
		url = `${url}/v1`;
	}
	return url;
}

// =============================================================================
// Model Definitions
// =============================================================================

const qwenCodeModels = [
	{
		id: "coder-model",
		name: "coder-model",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 65536,
		compat: {
			thinkingFormat: "qwen" as const,
			supportsDeveloperRole: false,
		},
	},
];

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("qwen", {
		baseUrl: QWEN_CODE_GLOBAL_BASE_URL,
		api: "openai-completions",
		models: qwenCodeModels,
		oauth: {
			name: "Qwen",
			login: loginQwen,
			refreshToken: refreshQwenToken,
			getApiKey: (cred) => cred.access,
			modifyModels: (models, cred) => {
				const baseUrl = getQwenBaseUrl(cred.enterpriseUrl as string | undefined);
				return models.map((m) => (m.provider === "qwen" ? { ...m, baseUrl } : m));
			},
		},
	});
}
