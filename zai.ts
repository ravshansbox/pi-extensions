import {
	type Api,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	streamSimpleAnthropic,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROVIDER_ID = "zai";
const BASE_URL = "https://api.z.ai/api/anthropic";

const MODELS = [
	{
		id: "glm-5",
		name: "GLM-5 (Z.AI)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "glm-4.7",
		name: "GLM-4.7 (Z.AI)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "glm-4.7-flash",
		name: "GLM-4.7 Flash (Z.AI)",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
];

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		apiKey: "zai",
		api: "anthropic-messages",
		models: MODELS,
		streamSimple: streamSimpleAnthropic,
	});
}
