/**
 * OpenCode Go Provider Extension for Pi
 *
 * Provides access to OpenCode Go models through the OpenCode API.
 * OpenCode Go is a $10/month subscription that provides reliable access
 * to popular open coding models with generous usage limits.
 */

import { type OAuthCredentials, type OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROVIDER_ID = "opencode-go";
const API_BASE_URL = "https://opencode.ai/zen/go/v1";
const API_BASE_URL_ANTHROPIC = "https://opencode.ai/zen/go";

interface OpenCodeGoModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image" | "video")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	api: "openai-completions" | "anthropic-messages";
}

const MODELS: OpenCodeGoModel[] = [
	{
		id: "glm-5",
		name: "GLM-5",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
		api: "openai-completions",
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image", "video"],
		cost: { input: 0.6, output: 3.0, cacheRead: 0.08, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
		api: "openai-completions",
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
		api: "anthropic-messages",
	},
];


async function loginOpenCodeGo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const key = (await callbacks.onPrompt({ message: "Paste OpenCode Go API key:" })).trim();
	if (!key) throw new Error("OpenCode Go API key is required");
	const cleaned = key.replace(/^Bearer\s+/i, "");
	return {
		refresh: cleaned,
		access: cleaned,
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	};
}

async function refreshOpenCodeGo(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return credentials;
}

export default function (pi: ExtensionAPI) {
	const models = MODELS.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens, api }) => ({
		id,
		name,
		reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
		api,
	}));

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: API_BASE_URL,
		api: "openai-completions",
		models,
		oauth: {
			name: "OpenCode Go",
			login: loginOpenCodeGo,
			refreshToken: refreshOpenCodeGo,
			getApiKey: (cred) => cred.access,
			modifyModels: (all) =>
				all.map((model) =>
					model.provider === PROVIDER_ID && model.api === "anthropic-messages"
						? { ...model, baseUrl: API_BASE_URL_ANTHROPIC }
						: model,
					),
		},
	});
}
