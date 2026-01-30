import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";

export function activate(context: vscode.ExtensionContext) {
	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
	const provider = new HuggingFaceChatModelProvider(context.secrets, tokenCountStatusBarItem);
	// Register the Hugging Face provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("oaicopilot", provider);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "OAI Compatible Provider API Key",
				prompt: existing ? "Update your OAI Compatible API key" : "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot.apiKey");
				vscode.window.showInformationMessage("OAI Compatible API key cleared.");
				return;
			}
			await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("OAI Compatible API key saved.");
		})
	);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot.models", []));

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found in oaicopilot.models configuration. Please configure models first."
				);
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `oaicopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: `OAI Compatible API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.generateGitCommitMessage", async (scm) => {
			generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("oaicopilot.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);

	// Silent command to set API key programmatically
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.silentSetApiKey", async (apiKey: string) => {
			if (apiKey !== undefined) {
				await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
				return;
			}
		})
	);

	// Silent command to set provider-specific API key programmatically
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.silentSetProviderApikey", async (apiKey: string, provider: string) => {
			if (provider !== undefined && apiKey !== undefined) {
				if (!provider) {
					// Get provider list from configuration for suggestions
					const config = vscode.workspace.getConfiguration();
					const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot.models", []));
					const providers = Array.from(
						new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
					).sort();

					if (providers.length > 0) {
						const selected = await vscode.window.showQuickPick(providers, {
							title: "Select Provider",
							placeHolder: "Select a provider for the API key",
						});
						if (!selected) {
							return; // user canceled
						}
						provider = selected;
					} else {
						const entered = await vscode.window.showInputBox({
							title: "Enter Provider Name",
							prompt: "Enter the provider name (will be converted to lowercase)",
							ignoreFocusOut: true,
						});
						if (!entered || !entered.trim()) {
							return; // user canceled
						}
						provider = entered.trim();
					}
				}
				await context.secrets.store(`oaicopilot.apiKey.${provider.toLowerCase()}`, apiKey.trim());
				return;
			}
		})
	);

	// Silent command to check if global API key is set
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.hasApiKey", async (): Promise<boolean> => {
			const apiKey = await context.secrets.get("oaicopilot.apiKey");
			return !!apiKey && apiKey.trim().length > 0;
		})
	);

	// Silent command to check if provider-specific API key is set
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.hasProviderApiKey", async (provider: string): Promise<boolean> => {
			if (!provider) {
				return false;
			}
			const apiKey = await context.secrets.get(`oaicopilot.apiKey.${provider.toLowerCase()}`);
			return !!apiKey && apiKey.trim().length > 0;
		})
	);

	// Silent command to set models configuration programmatically
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"oaicopilot.silentSetModelsConfig",
			async (models: HFModelItem[]): Promise<boolean> => {
				if (models === undefined || !Array.isArray(models)) {
					return false;
				}
				try {
					// Normalize models to ensure owned_by is set correctly from alias fields
					const normalizedModels = normalizeUserModels(models);
					const config = vscode.workspace.getConfiguration();
					await config.update("oaicopilot.models", normalizedModels, vscode.ConfigurationTarget.Global);
					return true;
				} catch {
					return false;
				}
			}
		)
	);
}

export function deactivate() {}
