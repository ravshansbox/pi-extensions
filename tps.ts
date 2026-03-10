/**
 * Tokens Per Second Extension
 *
 * Displays generation statistics after each agent response completes.
 * Shows input/output tokens, cache usage, cost, duration, and tokens/second.
 *
 * Output format:
 *   ↑{input} ↓{output} [R{cacheRead}] [W{cacheWrite}] ${cost} D{duration}s {tps}tps [{provider}, {email}]
 *
 * Example:
 *   ↑1.2k ↓345 R120 W30 $0.001 D2.3s 150.0tps [anthropic, user@example.com]
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// =============================================================================
// Types
// =============================================================================

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format large numbers with k/m suffixes
 */
function fmt(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "m";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
	return n.toString();
}

/**
 * Get email from auth.json for a given provider
 */
function getProviderEmail(provider: string): string | null {
	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		const entry = auth[provider];
		if (entry?.email) {
			return entry.email;
		}
	} catch {
		// Ignore errors, return null
	}
	return null;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;

		if (elapsedMs <= 0) return;

		// Aggregate token usage from all assistant messages
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			cost += message.usage.cost?.total || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;

		// Build display label
		const provider = ctx.model?.provider ?? "?";
		let login = provider;
		const email = getProviderEmail(provider);
		if (email && email !== provider) {
			login = `${provider}, ${email}`;
		}

		const price = `$${cost.toFixed(3)}`;
		const cacheParts: string[] = [];
		if (cacheRead > 0) cacheParts.push(`R${fmt(cacheRead)}`);
		if (cacheWrite > 0) cacheParts.push(`W${fmt(cacheWrite)}`);
		const cacheSegment = cacheParts.length > 0 ? ` ${cacheParts.join(" ")}` : "";

		const msg = `↑${fmt(input)} ↓${fmt(output)}${cacheSegment} ${price} D${elapsedSeconds.toFixed(1)}s ${tokensPerSecond.toFixed(1)}tps [${login}]`;
		ctx.ui.notify(msg, "info");
	});
}
