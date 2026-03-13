/**
 * OpenCode Zen Provider Extension
 *
 * Provides access to OpenCode Zen's free AI models.
 * Requires OPENCODE_API_KEY environment variable.
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/opencode-zen.ts
 *   # Set OPENCODE_API_KEY environment variable
 *
 * Free Models Available:
 *   - Nemotron 3 Super Free (1M context, reasoning)
 *   - GPT-5 Nano (400K context, image support)
 *   - MiniMax M2.5 Free (204K context, reasoning)
 *   - Big Pickle (200K context, reasoning)
 *   - MiMo V2 Flash Free (262K context, reasoning)
 */

import {
	type Api,
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_ID = "opencode";
const BASE_URL = "https://opencode.ai/zen/v1";

// Free models from OpenCode Zen (active only, no deprecated)
const FREE_MODELS = [
	{
		id: "nemotron-3-super-free",
		name: "Nemotron 3 Super Free",
		reasoning: true,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5-nano",
		name: "GPT-5 Nano",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "minimax-m2.5-free",
		name: "MiniMax M2.5 Free",
		reasoning: true,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
	},
	{
		id: "big-pickle",
		name: "Big Pickle",
		reasoning: true,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 128000,
	},
	{
		id: "mimo-v2-flash-free",
		name: "MiMo V2 Flash Free",
		reasoning: true,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
	},
];

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		apiKey: "OPENCODE_API_KEY",
		api: "openai-completions",
		models: FREE_MODELS,
		streamSimple: streamSimpleOpenAICompletions,
	});
}
