import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@mariozechner/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "@mariozechner/pi-ai/oauth";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";

const PROVIDER = "anthropic-multi";
const TITLE = "Anthropic Multi";
const BASE_URL = "https://api.anthropic.com";
const API = "anthropic-multi-api";
const STORE_PATH = path.join(os.homedir(), ".pi", "agent", "multi-provider-auth.json");
const EXPIRY_SKEW_MS = 60_000;
let currentSessionKey = "no-session";

interface StoredAccount {
	access: string;
	refresh?: string;
	expires?: number;
	email?: string;
	addedAt: number;
	lastRefreshedAt?: number;
}

interface ProviderAccounts {
	accounts: StoredAccount[];
}

type MultiProviderStore = Record<string, ProviderAccounts | undefined>;

const models = [
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		reasoning: false,
		input: ["text", "image"] as const,
		cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
];

function ensureStoreDir(): void {
	fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

function loadStore(): MultiProviderStore {
	try {
		if (fs.existsSync(STORE_PATH)) {
			return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as MultiProviderStore;
		}
	} catch {
		// ignore
	}
	return {};
}

function saveStore(store: MultiProviderStore): void {
	ensureStoreDir();
	fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getAccounts(): StoredAccount[] {
	return loadStore()[PROVIDER]?.accounts ?? [];
}

function setAccounts(accounts: StoredAccount[]): void {
	const store = loadStore();
	store[PROVIDER] = { accounts };
	saveStore(store);
}

function getSessionKey(ctx: { cwd: string; sessionManager: any }): string {
	return ctx.sessionManager?.getSessionFile?.() ?? ctx.sessionManager?.getLeafId?.() ?? `ephemeral:${ctx.cwd}`;
}

function hashIndex(sessionKey: string, accountCount: number): number {
	if (accountCount <= 0) return -1;
	const digest = createHash("sha256").update(sessionKey).digest();
	return digest.readUInt32BE(0) % accountCount;
}

function getAccountOrder(sessionKey: string, accountCount: number): number[] {
	if (accountCount <= 0) return [];
	const start = hashIndex(sessionKey, accountCount);
	return Array.from({ length: accountCount }, (_, i) => (start + i) % accountCount);
}

async function fetchEmail(accessToken: string): Promise<string | undefined> {
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as any;
		return data?.account?.email || undefined;
	} catch {
		return undefined;
	}
}

async function refreshAccountIfNeeded(index: number): Promise<StoredAccount | null> {
	const accounts = getAccounts();
	const account = accounts[index];
	if (!account) return null;
	if (!account.expires || account.expires - EXPIRY_SKEW_MS > Date.now()) return account;
	if (!account.refresh) return account.access ? account : null;

	try {
		const refreshed = await refreshAnthropicToken(account.refresh);
		const updated: StoredAccount = {
			...account,
			access: refreshed.access,
			refresh: refreshed.refresh || account.refresh,
			expires: refreshed.expires,
			lastRefreshedAt: Date.now(),
		};
		accounts[index] = updated;
		setAccounts(accounts);
		return updated;
	} catch {
		return account.access ? account : null;
	}
}

function formatAccountLine(index: number, account: StoredAccount, preferredIndex: number): string {
	const marker = index === preferredIndex ? "*" : " ";
	const email = account.email ?? "unknown";
	const expires = account.expires
		? account.expires < Date.now()
			? "expired"
			: `expires ${new Date(account.expires).toLocaleString()}`
		: "no expiry";
	return `${marker} [${index}] ${email} — ${expires}`;
}

async function promptInput(ctx: any, message: string): Promise<string> {
	const value = await ctx.ui.input(message);
	if (typeof value !== "string" || !value.trim()) throw new Error("Input cancelled");
	return value.trim();
}

async function openBrowser(url: string): Promise<void> {
	const platform = process.platform;
	const command =
		platform === "darwin"
			? `open '${url.replace(/'/g, `'\\''`)}'`
			: platform === "win32"
				? `start "" "${url.replace(/"/g, '""')}"`
				: `xdg-open '${url.replace(/'/g, `'\\''`)}'`;

	await new Promise<void>((resolve) => {
		exec(command, () => resolve());
	});
}

async function addAccount(ctx: any): Promise<StoredAccount> {
	const credentials = await loginAnthropic(
		(url) => {
			void openBrowser(url);
			ctx.ui.notify("Open this URL in your browser:", "info");
			ctx.ui.notify(url, "info");
		},
		() => promptInput(ctx, "Paste the Anthropic authorization code:"),
	);
	return {
		access: credentials.access,
		refresh: credentials.refresh,
		expires: credentials.expires,
		email: await fetchEmail(credentials.access),
		addedAt: Date.now(),
	};
}

async function handleCommand(args: string, ctx: any): Promise<void> {
	const [subcommand, rawIndex] = (args || "").trim().split(/\s+/, 2);
	const sessionKey = getSessionKey(ctx);

	switch (subcommand) {
		case "add": {
			const account = await addAccount(ctx);
			const accounts = getAccounts();
			accounts.push(account);
			setAccounts(accounts);
			ctx.ui.notify(`${TITLE} account added at index ${accounts.length - 1}${account.email ? ` (${account.email})` : ""}`, "success");
			return;
		}
		case "list": {
			const accounts = getAccounts();
			if (accounts.length === 0) {
				ctx.ui.notify(`${TITLE}: no accounts configured`, "info");
				return;
			}
			const preferredIndex = hashIndex(sessionKey, accounts.length);
			const lines = [
				`${TITLE} accounts`,
				"",
				...accounts.map((account, index) => formatAccountLine(index, account, preferredIndex)),
			];
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}
		case "": {
			ctx.ui.notify(`Usage: /${PROVIDER} [add|list|remove <index>]`, "error");
			return;
		}
		case "remove": {
			const index = Number(rawIndex);
			if (!Number.isInteger(index)) {
				ctx.ui.notify(`Usage: /${PROVIDER} remove <index>`, "error");
				return;
			}
			const accounts = getAccounts();
			if (index < 0 || index >= accounts.length) {
				ctx.ui.notify(`No account at index ${index}`, "error");
				return;
			}
			const removed = accounts[index];
			const ok = await ctx.ui.confirm(`Remove ${TITLE} account`, `Delete [${index}] ${removed.email ?? "unknown"}?`);
			if (!ok) return;
			accounts.splice(index, 1);
			setAccounts(accounts);
			ctx.ui.notify(`Removed ${TITLE} account [${index}]${removed.email ? ` (${removed.email})` : ""}`, "success");
			return;
		}
		default:
			ctx.ui.notify(`Usage: /${PROVIDER} [add|list|remove <index>]`, "error");
	}
}

function getArgumentCompletions(prefix: string) {
	const trimmed = prefix.trimStart();
	const parts = trimmed.split(/\s+/).filter(Boolean);
	const endsWithSpace = prefix.endsWith(" ");
	const accounts = getAccounts();

	if (parts.length === 0) {
		return [
			{ value: "add", label: "add" },
			{ value: "list", label: "list" },
			{ value: "remove", label: "remove" },
		];
	}

	if (parts.length === 1 && !endsWithSpace) {
		const subcommands = ["add", "list", "remove"];
		return subcommands
			.filter((item) => item.startsWith(parts[0]))
			.map((item) => ({ value: item, label: item }));
	}

	if (parts[0] === "remove") {
		const indexPrefix = endsWithSpace ? "" : (parts[1] ?? "");
		return accounts
			.map((_account, index) => String(index))
			.filter((index) => index.startsWith(indexPrefix))
			.map((index) => ({ value: `remove ${index}`, label: index }));
	}

	return null;
}

function remapAssistantMessage(message: any, model: Model<Api>) {
	if (!message || message.role !== "assistant") return message;
	return {
		...message,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

function remapStreamEvent(event: any, model: Model<Api>) {
	if (!event || typeof event !== "object") return event;
	const remapped = { ...event };
	if ("partial" in remapped) remapped.partial = remapAssistantMessage(remapped.partial, model);
	if ("message" in remapped) remapped.message = remapAssistantMessage(remapped.message, model);
	if ("error" in remapped) remapped.error = remapAssistantMessage(remapped.error, model);
	return remapped;
}

function makeFailoverStream() {
	return function streamMultiProvider(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

		(async () => {
			const accounts = getAccounts();
			const order = getAccountOrder(currentSessionKey, accounts.length);
			let lastError: any = null;

			for (const index of order) {
				const account = await refreshAccountIfNeeded(index);
				if (!account?.access) continue;

				const inner = streamSimple(
					{ ...model, api: "anthropic-messages", provider: "anthropic" } as any,
					context,
					{ ...options, apiKey: account.access },
				);
				const buffered: any[] = [];
				let committed = false;

				for await (const rawEvent of inner as any) {
					const event = remapStreamEvent(rawEvent, model);
					if (!committed) {
						if (event.type === "start") {
							buffered.push(event);
							continue;
						}
						if (event.type === "error") {
							lastError = event;
							break;
						}
						committed = true;
						for (const pending of buffered) stream.push(pending);
					}
					stream.push(event);
				}

				if (committed) {
					stream.end();
					return;
				}
			}

			if (lastError) {
				stream.push(lastError);
				stream.end();
				return;
			}

			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: `No usable accounts configured for ${PROVIDER}`,
					timestamp: Date.now(),
				},
			});
			stream.end();
		})();

		return stream;
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		currentSessionKey = getSessionKey(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentSessionKey = getSessionKey(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		currentSessionKey = getSessionKey(ctx);
	});

	pi.registerProvider(PROVIDER, {
		baseUrl: BASE_URL,
		apiKey: "__multi_provider_internal__",
		api: API as any,
		models,
		streamSimple: makeFailoverStream(),
	});

	pi.registerCommand(PROVIDER, {
		description: "Manage Anthropic multi-account provider",
		getArgumentCompletions,
		handler: async (args, ctx) => handleCommand(args, ctx),
	});
}
