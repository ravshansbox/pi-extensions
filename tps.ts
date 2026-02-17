import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}
function fmt(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "m";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
	return n.toString();
}

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
		const provider = ctx.model?.provider ?? "?";
		let login = provider;
		try {
			const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
			const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
			const entry = auth[provider];
			if (entry?.email) login = entry.email;
		} catch {}
		const label = login !== provider ? `${provider}, ${login}` : provider;
		const price = cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
		const msg = `↑${fmt(output)} ↓${fmt(input)} R${fmt(cacheRead)} W${fmt(cacheWrite)} ${price} D${elapsedSeconds.toFixed(1)}s ${tokensPerSecond.toFixed(1)}tps [${label}]`;
		ctx.ui.notify(msg, "info");
	});
}
