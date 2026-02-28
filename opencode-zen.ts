import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
const PROVIDER_ID = "opencode-zen";
const BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_HEADERS: Record<string, string> = {
	"HTTP-Referer": "https://opencode.ai/",
	"X-Title": "opencode",
};
const FREE_MODELS = [
	{
		id: "kimi-k2.5-free",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 262144,
	},
	{
		id: "glm-5-free",
		name: "GLM-5",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
	},
	{
		id: "big-pickle",
		name: "Big Pickle",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 128000,
	},
	{
		id: "minimax-m2.5-free",
		name: "MiniMax M2.5",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
	},
	{
		id: "gpt-5-nano",
		name: "GPT-5 Nano",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	},
];
async function loginZen(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const key = (await callbacks.onPrompt({ message: "Paste OpenCode Zen API key:" })).trim();
	if (!key) throw new Error("OpenCode Zen API key is required");
	const cleaned = key.replace(/^Bearer\s+/i, "");
	return {
		refresh: cleaned,
		access: cleaned,
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	};
}
async function refreshZenToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return credentials;
}
export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		api: "openai-completions",
		authHeader: true,
		headers: DEFAULT_HEADERS,
		models: FREE_MODELS,
		oauth: {
			name: "OpenCode Zen",
			login: loginZen,
			refreshToken: refreshZenToken,
			getApiKey: (cred) => cred.access,
		},
		streamSimple: streamSimpleOpenAICompletions,
	});
}
