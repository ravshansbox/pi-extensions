import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { visibleWidth, matchesKey } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetsAt?: Date;
}
interface ProviderStatus {
	indicator: "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";
	description?: string;
}
interface UsageSnapshot {
	provider: string;
	displayName: string;
	windows: RateWindow[];
	plan?: string;
	error?: string;
	status?: ProviderStatus;
	selected?: boolean;
	authKey?: string;
}
const FETCH_TIMEOUT_MS = 10000;
const USAGE_RACE_TIMEOUT_MS = 15000;
const STATUS_RACE_TIMEOUT_MS = 8000;

const STATUS_URLS: Record<string, string> = {
	anthropic: "https://status.anthropic.com/api/v2/status.json",
	codex: "https://status.openai.com/api/v2/status.json",
	copilot: "https://www.githubstatus.com/api/v2/status.json",
};
async function fetchProviderStatus(provider: string): Promise<ProviderStatus> {
	const url = STATUS_URLS[provider];
	if (!url) return { indicator: "none" };
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const res = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return { indicator: "unknown" };
		const data = await res.json() as any;
		const indicator = data.status?.indicator || "none";
		const description = data.status?.description;
		return { indicator: indicator as ProviderStatus["indicator"], description };
	} catch {
		return { indicator: "unknown" };
	}
}
function loadAuthData(): Record<string, any> {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(piAuthPath)) {
			return JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
		}
	} catch {}
	return {};
}

function getAuthEntriesForProvider(authData: Record<string, any>, providerPrefix: string): string[] {
	// Get all keys that start with the provider prefix (e.g., "anthropic", "anthropic-1", etc.)
	return Object.keys(authData).filter(key => 
		key === providerPrefix || key.startsWith(providerPrefix + "-")
	);
}

function getSelectedAuthKey(authData: Record<string, any>, providerPrefix: string): string | undefined {
	// The selected account is stored in the base key (e.g., "anthropic" not "anthropic-1")
	const entry = authData[providerPrefix];
	if (entry?.access || entry?.key) {
		return providerPrefix;
	}
	// Otherwise, find the first numbered one
	const keys = getAuthEntriesForProvider(authData, providerPrefix);
	return keys.length > 0 ? keys[0] : undefined;
}

interface ClaudeProfile {
	email?: string;
	plan?: string;
}
async function fetchClaudeProfile(token: string): Promise<ClaudeProfile> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
			},
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return {};
		const data = await res.json() as any;
		let plan: string | undefined;
		if (data.account?.has_claude_max) {
			plan = "claude max";
		} else if (data.account?.has_claude_pro) {
			plan = "claude pro";
		} else if (data.organization?.organization_type === "claude_team") {
			plan = "team";
		}
		return {
			email: data?.account?.email,
			plan,
		};
	} catch {
		return {};
	}
}
async function fetchClaudeUsage(): Promise<UsageSnapshot[]> {
	const authData = loadAuthData();
	const anthropicKeys = getAuthEntriesForProvider(authData, "anthropic");
	const selectedKey = getSelectedAuthKey(authData, "anthropic");
	
	const snapshots: UsageSnapshot[] = [];
	
	// Try keychain as fallback
	let keychainToken: string | undefined;
	try {
		const keychainData = execSync(
			'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
		).trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData);
			const scopes = parsed.claudeAiOauth?.scopes || [];
			if (scopes.includes("user:profile") && parsed.claudeAiOauth?.accessToken) {
				keychainToken = parsed.claudeAiOauth.accessToken;
			}
		}
	} catch {}
	
	// If no auth entries found, try keychain
	if (anthropicKeys.length === 0 && keychainToken) {
		const snapshot = await fetchClaudeProfileAndUsage(keychainToken);
		if (snapshot) snapshots.push(snapshot);
	}
	
	// Fetch for each anthropic auth entry
	for (const key of anthropicKeys) {
		const entry = authData[key];
		if (!entry?.access) continue;
		
		const snapshot = await fetchClaudeProfileAndUsage(entry.access, key);
		if (snapshot) {
			snapshot.selected = key === selectedKey;
			snapshot.authKey = key;
			snapshots.push(snapshot);
		}
	}
	
	if (snapshots.length === 0) {
		snapshots.push({ provider: "anthropic", displayName: "claude", windows: [], error: "no credentials" });
	}
	
	return snapshots;
}

async function fetchClaudeProfileAndUsage(token: string, authKey: string = "anthropic"): Promise<UsageSnapshot | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const [usageRes, profile] = await Promise.all([
			fetch("https://api.anthropic.com/api/oauth/usage", {
				headers: {
					Authorization: `Bearer ${token}`,
					"anthropic-beta": "oauth-2025-04-20",
				},
				signal: controller.signal,
			}),
			fetchClaudeProfile(token),
		]);
		clearTimeout(timer);
		const res = usageRes;
		if (!res.ok) {
			const baseName = authKey === "anthropic" ? "claude" : `claude (${authKey})`;
			return { provider: "anthropic", displayName: profile.email ? `claude (${profile.email})` : baseName, windows: [], error: `http ${res.status}` };
		}
		const data = await res.json() as any;
		const windows: RateWindow[] = [];
		if (data.five_hour?.utilization !== undefined) {
			windows.push({
				label: "5h",
				usedPercent: data.five_hour.utilization,
				resetDescription: data.five_hour.resets_at ? formatReset(new Date(data.five_hour.resets_at)) : undefined,
			});
		}
		if (data.seven_day?.utilization !== undefined) {
			windows.push({
				label: "week",
				usedPercent: data.seven_day.utilization,
				resetDescription: data.seven_day.resets_at ? formatReset(new Date(data.seven_day.resets_at)) : undefined,
			});
		}
		const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
		if (modelWindow?.utilization !== undefined) {
			windows.push({
				label: data.seven_day_sonnet ? "sonnet" : "opus",
				usedPercent: modelWindow.utilization,
			});
		}
		const baseName = authKey === "anthropic" ? "claude" : `claude (${authKey})`;
		const displayName = profile.email ? `claude (${profile.email})` : baseName;
		return { provider: "anthropic", displayName, windows, plan: profile.plan };
	} catch (e) {
		const baseName = authKey === "anthropic" ? "claude" : `claude (${authKey})`;
		return { provider: "anthropic", displayName: baseName, windows: [], error: String(e) };
	}
}

async function fetchCodexProfileEmail(accessToken: string): Promise<string | undefined> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const res = await fetch("https://api.openai.com/v1/me", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return undefined;
		const data = await res.json() as any;
		return data?.email || undefined;
	} catch {
		return undefined;
	}
}
function loadCodexCachedEmailForKey(authKey: string): string | undefined {
	const piAuthPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
	try {
		if (fs.existsSync(piAuthPath)) {
			const data = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
			const entry = data[authKey];
			if (entry?.email) return entry.email;
		}
	} catch {}
	return undefined;
}

async function fetchCodexUsage(modelRegistry: any): Promise<UsageSnapshot[]> {
	const authData = loadAuthData();
	const codexKeys = getAuthEntriesForProvider(authData, "openai-codex");
	const selectedKey = getSelectedAuthKey(authData, "openai-codex");
	
	const snapshots: UsageSnapshot[] = [];
	
	// Try modelRegistry first
	let modelRegistryToken: string | undefined;
	let modelRegistryAccountId: string | undefined;
	try {
		modelRegistryToken = await modelRegistry?.authStorage?.getApiKey?.("openai-codex");
		const cred = modelRegistry?.authStorage?.get?.("openai-codex");
		if (cred?.type === "oauth") {
			modelRegistryAccountId = (cred as any).accountId;
		}
	} catch {}
	
	// If no auth entries found, try modelRegistry or codex home
	if (codexKeys.length === 0) {
		let accessToken = modelRegistryToken;
		let accountId = modelRegistryAccountId;
		
		if (!accessToken) {
			const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
			const authPath = path.join(codexHome, "auth.json");
			try {
				if (fs.existsSync(authPath)) {
					const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
					if (data.OPENAI_API_KEY) {
						accessToken = data.OPENAI_API_KEY;
					} else if (data.tokens?.access_token) {
						accessToken = data.tokens.access_token;
						accountId = data.tokens.account_id;
					}
				}
			} catch {}
		}
		
		if (accessToken) {
			const snapshot = await fetchCodexProfileAndUsage(accessToken, accountId, "openai-codex");
			snapshot.selected = true;
			snapshot.authKey = "openai-codex";
			snapshots.push(snapshot);
		}
	}
	
	// Fetch for each openai-codex auth entry
	for (const key of codexKeys) {
		const entry = authData[key];
		if (!entry?.access) continue;
		
		const snapshot = await fetchCodexProfileAndUsage(entry.access, entry.accountId, key);
		snapshot.selected = key === selectedKey;
		snapshot.authKey = key;
		snapshots.push(snapshot);
	}
	
	if (snapshots.length === 0) {
		snapshots.push({ provider: "codex", displayName: "codex", windows: [], error: "no credentials" });
	}
	
	return snapshots;
}

async function fetchCodexProfileAndUsage(accessToken: string, accountId: string | undefined, authKey: string = "openai-codex"): Promise<UsageSnapshot> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "CodexBar",
			Accept: "application/json",
		};
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}
		const cachedEmail = loadCodexCachedEmailForKey(authKey);
		const [res, codexEmail] = await Promise.all([
			fetch("https://chatgpt.com/backend-api/wham/usage", {
				method: "GET",
				headers,
				signal: controller.signal,
			}),
			cachedEmail ? Promise.resolve(cachedEmail) : fetchCodexProfileEmail(accessToken),
		]);
		clearTimeout(timer);
		if (res.status === 401 || res.status === 403) {
			const baseName = authKey === "openai-codex" ? "codex" : `codex (${authKey})`;
			return { provider: "codex", displayName: codexEmail ? `codex (${codexEmail})` : baseName, windows: [], error: "token expired" };
		}
		if (!res.ok) {
			const baseName = authKey === "openai-codex" ? "codex" : `codex (${authKey})`;
			return { provider: "codex", displayName: codexEmail ? `codex (${codexEmail})` : baseName, windows: [], error: `http ${res.status}` };
		}
		const data = await res.json() as any;
		const windows: RateWindow[] = [];
		if (data.rate_limit?.primary_window) {
			const pw = data.rate_limit.primary_window;
			const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
			const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
			windows.push({
				label: `${windowHours}h`,
				usedPercent: pw.used_percent || 0,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
			});
		}
		if (data.rate_limit?.secondary_window) {
			const sw = data.rate_limit.secondary_window;
			const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
			windows.push({
				label: "week",
				usedPercent: sw.used_percent || 0,
				resetDescription: resetDate ? formatReset(resetDate) : undefined,
			});
		}
		let plan = data.plan_type;
		if (data.credits?.balance !== undefined && data.credits.balance !== null) {
			const balance = typeof data.credits.balance === 'number'
				? data.credits.balance
				: parseFloat(data.credits.balance) || 0;
			plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
		}
		const baseName = authKey === "openai-codex" ? "codex" : `codex (${authKey})`;
		const displayName = codexEmail ? `codex (${codexEmail})` : baseName;
		return { provider: "codex", displayName, windows, plan };
	} catch (e) {
		const baseName = authKey === "openai-codex" ? "codex" : `codex (${authKey})`;
		return { provider: "codex", displayName: baseName, windows: [], error: String(e) };
	}
}
async function fetchZaiUsage(): Promise<UsageSnapshot[]> {
	const authData = loadAuthData();
	const zaiKeys = getAuthEntriesForProvider(authData, "zai");
	const selectedKey = getSelectedAuthKey(authData, "zai");
	
	const snapshots: UsageSnapshot[] = [];
	
	// Try env var first
	let envApiKey = process.env.Z_AI_API_KEY;
	
	// If no auth entries found, try env var
	if (zaiKeys.length === 0 && envApiKey) {
		const snapshot = await fetchZaiProfileAndUsage(envApiKey);
		snapshot.selected = true;
		snapshot.authKey = "zai";
		snapshots.push(snapshot);
	}
	
	// Fetch for each zai auth entry
	for (const key of zaiKeys) {
		const entry = authData[key];
		if (!entry?.key) continue;
		
		const snapshot = await fetchZaiProfileAndUsage(entry.key, key);
		snapshot.selected = key === selectedKey;
		snapshot.authKey = key;
		snapshots.push(snapshot);
	}
	
	if (snapshots.length === 0) {
		snapshots.push({ provider: "zai", displayName: "z.ai", windows: [], error: "no api key" });
	}
	
	return snapshots;
}

async function fetchZaiProfileAndUsage(apiKey: string, authKey: string = "zai"): Promise<UsageSnapshot> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			const baseName = authKey === "zai" ? "z.ai" : `z.ai (${authKey})`;
			return { provider: "zai", displayName: baseName, windows: [], error: `http ${res.status}` };
		}
		const data = await res.json() as any;
		if (!data.success || data.code !== 200) {
			const baseName = authKey === "zai" ? "z.ai" : `z.ai (${authKey})`;
			return { provider: "zai", displayName: baseName, windows: [], error: data.msg || "api error" };
		}
		const windows: RateWindow[] = [];
		const limits = data.data?.limits || [];
		for (const limit of limits) {
			const type = limit.type;
			const percent = limit.percentage || 0;
			const nextReset = limit.nextResetTime ? new Date(limit.nextResetTime) : undefined;
			let windowLabel = "limit";
			if (limit.unit === 1) windowLabel = `${limit.number}d`;
			else if (limit.unit === 3) windowLabel = `${limit.number}h`;
			else if (limit.unit === 5) windowLabel = `${limit.number}m`;
			if (type === "TOKENS_LIMIT") {
				windows.push({
					label: `${windowLabel}`,
					usedPercent: percent,
					resetDescription: nextReset ? formatReset(nextReset) : undefined,
				});
			} else if (type === "TIME_LIMIT") {
				windows.push({
					label: "month",
					usedPercent: percent,
					resetDescription: nextReset ? formatReset(nextReset) : undefined,
				});
			}
		}
		const planName = data.data?.planName || data.data?.plan || undefined;
		const baseName = authKey === "zai" ? "z.ai" : `z.ai (${authKey})`;
		if (windows.length === 0 && planName) {
			return { provider: "zai", displayName: `z.ai (${planName})`, windows, plan: planName };
		}
		return { provider: "zai", displayName: baseName, windows, plan: planName };
	} catch (e) {
		const baseName = authKey === "zai" ? "z.ai" : `z.ai (${authKey})`;
		return { provider: "zai", displayName: baseName, windows: [], error: String(e) };
	}
}
function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";
	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 60) return `${diffMins}m`;
	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ${hours % 24}h`;
	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}
function getStatusIndicator(status?: ProviderStatus): string {
	if (!status) return "";
	switch (status.indicator) {
		case "none": return "[ok]";
		case "minor": return "[!]";
		case "major": return "[!!]";
		case "critical": return "[!!!]";
		case "maintenance": return "[maint]";
		default: return "";
	}
}
function reorganizeKeys(auth: Record<string, any>, selectedKey: string, prefix: string): Record<string, any> {
	const result = { ...auth };
	const providerKeys = Object.keys(result).filter(k => k === prefix || k.startsWith(prefix + "-"));
	for (const key of providerKeys) {
		delete result[key];
	}
	const selectedAuth = auth[selectedKey];
	if (selectedAuth) {
		result[prefix] = selectedAuth;
	}
	let counter = 1;
	for (const [key, value] of Object.entries(auth)) {
		if ((key === prefix || key.startsWith(prefix + "-")) && key !== selectedKey) {
			result[`${prefix}-${counter}`] = value;
			counter++;
		}
	}
	return result;
}
function getAuthPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "auth.json");
}
function saveAuth(auth: Record<string, any>): void {
	fs.writeFileSync(getAuthPath(), JSON.stringify(auth, null, 2));
}
class UsageComponent {
	private usages: UsageSnapshot[] = [];
	private loading = true;
	private tui: { requestRender: () => void };
	private theme: any;
	private onClose: () => void;
	private modelRegistry: any;
	private cursor = 0;
	private selectableIndices: number[] = [];
	private switching = false;
	private providerGroups = new Map<string, number[]>();
	constructor(tui: { requestRender: () => void }, theme: any, onClose: () => void, modelRegistry: any) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.modelRegistry = modelRegistry;
		this.load();
	}
	private async load() {
		const timeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
			Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
		const [claudeSnapshots, codexSnapshots, zaiSnapshots, claudeStatus, codexStatus] = await Promise.all([
			timeout(fetchClaudeUsage(), USAGE_RACE_TIMEOUT_MS, [{ provider: "anthropic", displayName: "claude", windows: [], error: "timeout" }]),
			timeout(fetchCodexUsage(this.modelRegistry), USAGE_RACE_TIMEOUT_MS, [{ provider: "codex", displayName: "codex", windows: [], error: "timeout" }]),
			timeout(fetchZaiUsage(), USAGE_RACE_TIMEOUT_MS, [{ provider: "zai", displayName: "z.ai", windows: [], error: "timeout" }]),
			timeout(fetchProviderStatus("anthropic"), STATUS_RACE_TIMEOUT_MS, { indicator: "unknown" as const }),
			timeout(fetchProviderStatus("codex"), STATUS_RACE_TIMEOUT_MS, { indicator: "unknown" as const }),
		]);
		for (const s of claudeSnapshots) s.status = claudeStatus;
		for (const s of codexSnapshots) s.status = codexStatus;
		const allUsages = [...claudeSnapshots, ...codexSnapshots, ...zaiSnapshots];
		this.usages = allUsages.filter(u =>
			u.windows.length > 0 ||
			u.plan ||
			(u.error !== "no api key" && u.error !== "no credentials" && u.error !== "no token")
		);
		this.selectableIndices = [];
		this.providerGroups = new Map<string, number[]>();
		for (let i = 0; i < this.usages.length; i++) {
			const p = this.usages[i].provider;
			if (!this.providerGroups.has(p)) this.providerGroups.set(p, []);
			this.providerGroups.get(p)!.push(i);
		}
		for (const indices of this.providerGroups.values()) {
			if (indices.length > 1) {
				for (const idx of indices) {
					if (!this.usages[idx].selected) {
						this.selectableIndices.push(idx);
					}
				}
			}
		}
		if (this.selectableIndices.length > 0) {
			this.cursor = 0;
		}
		this.loading = false;
		this.tui.requestRender();
	}
	private async switchAccount(usage: UsageSnapshot) {
		if (!usage.authKey) return;
		this.switching = true;
		this.tui.requestRender();
		const prefix = usage.provider === "anthropic" ? "anthropic"
			: usage.provider === "codex" ? "openai-codex"
			: usage.provider === "zai" ? "zai" : usage.provider;
		const auth = loadAuthData();
		const updated = reorganizeKeys(auth, usage.authKey, prefix);
		saveAuth(updated);
		this.modelRegistry.authStorage.reload();
		this.switching = false;
		this.onClose();
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}
		if (this.selectableIndices.length === 0) return;
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.cursor > 0) {
				this.cursor--;
				this.tui.requestRender();
			}
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.cursor < this.selectableIndices.length - 1) {
				this.cursor++;
				this.tui.requestRender();
			}
		} else if (matchesKey(data, "enter")) {
			const idx = this.selectableIndices[this.cursor];
			const usage = this.usages[idx];
			if (!usage.selected) {
				this.switchAccount(usage);
			}
		}
	}
	invalidate(): void {}
	render(width: number): string[] {
		const t = this.theme;
		const dim = (s: string) => t.fg("muted", s);
		const bold = (s: string) => t.bold(s);
		const accent = (s: string) => t.fg("accent", s);
		const totalW = width - 4;
		const innerW = totalW - 4;
		const hLine = "─".repeat(totalW - 2);
		const box = (content: string) => {
			const contentW = visibleWidth(content);
			const pad = Math.max(0, innerW - contentW);
			return dim("│ ") + content + " ".repeat(pad) + dim(" │");
		};
		const lines: string[] = [];
		lines.push(dim(`╭${hLine}╮`));
		lines.push(box(bold(accent("usage"))));
		lines.push(dim(`├${hLine}┤`));
		if (this.loading || this.switching) {
			lines.push(box(this.switching ? "switching..." : "loading..."));
		} else {
			for (let i = 0; i < this.usages.length; i++) {
				const u = this.usages[i];
				const isSelectable = this.selectableIndices.includes(i);
				const isCursor = isSelectable && this.selectableIndices[this.cursor] === i;
				const statusIndicator = getStatusIndicator(u.status);
				const planStr = u.plan ? dim(` (${u.plan})`) : "";
				const statusStr = statusIndicator ? ` ${statusIndicator}` : "";
				let radioStr = "";
				if (u.selected) {
					radioStr = ` ${accent("●")}`;
				} else if (isSelectable) {
					const pointer = isCursor ? accent("› ") : "  ";
					radioStr = ` ${pointer}${dim("○")}`;
				}
				lines.push(box(bold(u.displayName) + planStr + statusStr + radioStr));
				if (u.status?.indicator && u.status.indicator !== "none" && u.status.indicator !== "unknown" && u.status.description) {
					const desc = u.status.description.length > 40
						? u.status.description.substring(0, 37).toLowerCase() + "..."
						: u.status.description.toLowerCase();
					lines.push(box(t.fg("warning", `  ${desc}`)));
				}
				if (u.error) {
					lines.push(box(dim(`  ${u.error}`)));
				} else if (u.windows.length === 0) {
					lines.push(box(dim("  no data")));
				} else {
					for (const w of u.windows) {
						const remaining = Math.max(0, 100 - w.usedPercent);
						const barW = 12;
						const filled = Math.min(barW, Math.round((w.usedPercent / 100) * barW));
						const empty = barW - filled;
						const color = remaining <= 10 ? "error" : remaining <= 30 ? "warning" : "success";
						const bar = t.fg(color, "█".repeat(filled)) + dim("░".repeat(empty));
						const reset = w.resetDescription ? dim(` ${w.resetDescription}`) : "";
						lines.push(box(`  ${w.label.padEnd(7)} ${bar} ${remaining.toFixed(0).padStart(3)}%${reset}`));
					}
				}
				lines.push(box(""));
			}
		}
		lines.push(dim(`├${hLine}┤`));
		const hint = this.selectableIndices.length > 0
			? "↑↓ navigate  enter switch  esc close"
			: "press esc to close";
		lines.push(box(dim(hint)));
		lines.push(dim(`╰${hLine}╯`));
		return lines;
	}
	dispose(): void {}
}
export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "show ai provider usage statistics",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("usage requires interactive mode", "error");
				return;
			}
			const modelRegistry = ctx.modelRegistry;
			await ctx.ui.custom((tui, theme, _kb, done) => {
				return new UsageComponent(tui, theme, () => done(), modelRegistry);
			});
		},
	});
}
