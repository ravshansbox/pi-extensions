import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { visibleWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
interface DailyCost {
	date: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	requests: number;
}
interface ProviderCost {
	provider: string;
	displayName: string;
	days: DailyCost[];
	totalCost: number;
	totalRequests: number;
	models: Map<string, number>;
}
async function scanSessionLogs(daysBack: number = 30): Promise<ProviderCost[]> {
	const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	const providerCosts = new Map<string, ProviderCost>();
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - daysBack);
	if (!fs.existsSync(sessionsDir)) {
		return [];
	}
	const sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => path.join(sessionsDir, d.name));
	for (const dir of sessionDirs) {
		const files = fs.readdirSync(dir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(dir, f));
		for (const file of files) {
			await scanSessionFile(file, cutoffDate, providerCosts);
		}
	}
	return Array.from(providerCosts.values())
		.sort((a, b) => b.totalCost - a.totalCost);
}
async function scanSessionFile(
	filePath: string,
	cutoffDate: Date,
	providerCosts: Map<string, ProviderCost>
): Promise<void> {
	const fileStream = fs.createReadStream(filePath);
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity,
	});
	for await (const line of rl) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const msg = entry.message;
				const timestamp = new Date(entry.timestamp || msg.timestamp);
				if (timestamp < cutoffDate) continue;
				const provider = msg.provider || "unknown";
				const model = msg.model || "unknown";
				const usage = msg.usage;
				if (!usage?.cost) continue;
				const dateKey = timestamp.toISOString().split('T')[0];
				if (!providerCosts.has(provider)) {
					providerCosts.set(provider, {
						provider,
						displayName: formatProviderName(provider),
						days: [],
						totalCost: 0,
						totalRequests: 0,
						models: new Map(),
					});
				}
				const pc = providerCosts.get(provider)!;
				let day = pc.days.find(d => d.date === dateKey);
				if (!day) {
					day = {
						date: dateKey,
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
						requests: 0,
					};
					pc.days.push(day);
				}
				day.input += usage.cost.input || 0;
				day.output += usage.cost.output || 0;
				day.cacheRead += usage.cost.cacheRead || 0;
				day.cacheWrite += usage.cost.cacheWrite || 0;
				day.total += usage.cost.total || 0;
				day.requests += 1;
				pc.totalCost += usage.cost.total || 0;
				pc.totalRequests += 1;
				const modelCost = pc.models.get(model) || 0;
				pc.models.set(model, modelCost + (usage.cost.total || 0));
			}
		} catch {
		}
	}
}
function formatProviderName(provider: string): string {
	const names: Record<string, string> = {
		anthropic: "Claude",
		openai: "OpenAI",
		"openai-codex": "Codex",
		google: "Gemini",
		"google-gemini-cli": "Gemini",
		"github-copilot": "Copilot",
	};
	return names[provider] || provider;
}
function deleteProviderFromSessions(provider: string): void {
	const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	if (!fs.existsSync(sessionsDir)) return;
	const sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => path.join(sessionsDir, d.name));
	for (const dir of sessionDirs) {
		const files = fs.readdirSync(dir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => path.join(dir, f));
		for (const file of files) {
			const content = fs.readFileSync(file, "utf-8");
			const lines = content.split('\n').filter(line => {
				if (!line.trim()) return false;
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message?.role === "assistant") {
						const msg = entry.message;
						const msgProvider = msg.provider || "unknown";
						if (msgProvider === provider) return false;
					}
					return true;
				} catch {
					return true;
				}
			});
			fs.writeFileSync(file, lines.join('\n') + '\n');
		}
	}
}
class CostComponent {
	private costs: ProviderCost[] = [];
	private loading = true;
	private tui: { requestRender: () => void };
	private theme: any;
	private onClose: () => void;
	private daysBack: number;
	private expanded: string | null = null;
	private cursor: number = 0;
	constructor(tui: { requestRender: () => void }, theme: any, onClose: () => void, daysBack: number) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.daysBack = daysBack;
		this.load();
	}
	private async load() {
		this.costs = await scanSessionLogs(this.daysBack);
		this.loading = false;
		this.tui.requestRender();
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onClose();
		} else if (matchesKey(data, Key.up)) {
			if (this.costs.length > 0) {
				this.cursor = (this.cursor - 1 + this.costs.length) % this.costs.length;
				this.tui.requestRender();
			}
		} else if (matchesKey(data, Key.down)) {
			if (this.costs.length > 0) {
				this.cursor = (this.cursor + 1) % this.costs.length;
				this.tui.requestRender();
			}
		} else if (matchesKey(data, Key.enter)) {
			if (this.costs.length > 0) {
				const pc = this.costs[this.cursor];
				this.expanded = this.expanded === pc.provider ? null : pc.provider;
				this.tui.requestRender();
			}
		} else if (matchesKey(data, Key.backspace)) {
			if (this.costs.length > 0) {
				const pc = this.costs[this.cursor];
				deleteProviderFromSessions(pc.provider);
				this.costs.splice(this.cursor, 1);
				if (this.costs.length === 0) {
					this.cursor = 0;
				} else if (this.cursor >= this.costs.length) {
					this.cursor = this.costs.length - 1;
				}
				this.tui.requestRender();
			}
		}
	}
	invalidate(): void {}
	render(width: number): string[] {
		const t = this.theme;
		const dim = (s: string) => t.fg("muted", s);
		const bold = (s: string) => t.bold(s);
		const accent = (s: string) => t.fg("accent", s);
		const success = (s: string) => t.fg("success", s);
		const warning = (s: string) => t.fg("warning", s);
		const totalW = Math.min(65, width - 4);
		const innerW = totalW - 4;
		const hLine = "─".repeat(totalW - 2);
		const box = (content: string) => {
			const contentW = visibleWidth(content);
			const pad = Math.max(0, innerW - contentW);
			return dim("│ ") + content + " ".repeat(pad) + dim(" │");
		};
		const lines: string[] = [];
		lines.push(dim(`╭${hLine}╮`));
		lines.push(box(bold(accent(`cost (${this.daysBack} days)`))));
		lines.push(dim(`├${hLine}┤`));
		if (this.loading) {
			lines.push(box("scanning session logs..."));
		} else if (this.costs.length === 0) {
			lines.push(box(dim("no usage data found")));
		} else {
			let grandTotal = 0;
			let idx = 0;
			for (const pc of this.costs) {
				grandTotal += pc.totalCost;
				const costStr = `$${pc.totalCost.toFixed(4)}`;
				const color = pc.totalCost > 1 ? warning : success;
				const cursorMark = idx === this.cursor ? bold(accent("> ")) : "  ";
				lines.push(box(`${cursorMark}${bold(pc.displayName.toLowerCase())} ${color(costStr)} ${dim(`(${pc.totalRequests} requests)`)}`));
				if (this.expanded === pc.provider) {
					const sortedModels = Array.from(pc.models.entries())
						.sort((a, b) => b[1] - a[1])
						.slice(0, 3);
					for (const [model, cost] of sortedModels) {
						const shortModel = model.length > 25 ? model.substring(0, 22) + "..." : model;
						lines.push(box(dim(`    ${shortModel.toLowerCase()}: $${cost.toFixed(4)}`)));
					}
					const recentDays = pc.days
						.sort((a, b) => b.date.localeCompare(a.date))
						.slice(0, 5);
					if (recentDays.length > 0) {
						lines.push(box(dim("    recent:")));
						for (const day of recentDays) {
							lines.push(box(dim(`      ${day.date}: $${day.total.toFixed(4)} (${day.requests} req)`)));
						}
					}
				}
				idx++;
			}
			lines.push(dim(`├${hLine}┤`));
			const totalColor = grandTotal > 10 ? warning : success;
			lines.push(box(`${bold("total:")} ${totalColor(`$${grandTotal.toFixed(4)}`)}`));
		}
		lines.push(dim(`├${hLine}┤`));
		lines.push(box(dim("↑↓ navigate  enter expand  backspace hide  esc close")));
		lines.push(dim(`╰${hLine}╯`));
		return lines;
	}
	dispose(): void {}
}
export default function (pi: ExtensionAPI) {
	pi.registerCommand("cost", {
		description: "Show cost report from session logs",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Cost report requires interactive mode", "error");
				return;
			}
			const daysBack = parseInt(args || "30") || 30;
			await ctx.ui.custom((tui, theme, _kb, done) => {
				return new CostComponent(tui, theme, () => done(undefined), daysBack);
			});
		},
	});
}
