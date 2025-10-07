import * as vscode from 'vscode';
import { SemgrepResultsPanel } from './SemgrepResultsPanel';

/**
 * Activates the extension.
 */
export function activate(context: vscode.ExtensionContext) {

	// Register the command to open the results panel
	let disposable = vscode.commands.registerCommand('semgrep-triage.openResults', async () => {
		
		// Prompt user to select a Semgrep results JSON file
		const uri = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: {
				'JSON Files': ['json']
			},
			title: 'Select Semgrep Results JSON File'
		});

		if (uri && uri.length > 0) {
			const filePath = uri[0].fsPath;
			
			try {
				// Read the file content
				const fileData = await vscode.workspace.fs.readFile(uri[0]);
				const content = Buffer.from(fileData).toString('utf8');
				const resultsJson = JSON.parse(content);

				if (resultsJson && Array.isArray(resultsJson.results)) {
					// Create and show the Webview panel, passing the parsed results
					SemgrepResultsPanel.createOrShow(context.extensionUri, resultsJson.results, filePath);
				} else {
					vscode.window.showErrorMessage('Invalid Semgrep results format: "results" array not found.');
				}
			} catch (e: any) {
				vscode.window.showErrorMessage(`Failed to read or parse file: ${e.message}`);
			}
		}
	});

	let disposable2 = vscode.commands.registerCommand('semgrep-triage.openEmpty', async () => {
		
		const resultsJson = {results:[]}

		if (resultsJson && Array.isArray(resultsJson.results)) {
			// Create and show the Webview panel, passing the parsed results
			SemgrepResultsPanel.createOrShow(context.extensionUri, resultsJson.results, "");
		} else {
			vscode.window.showErrorMessage('Invalid Semgrep results format: "results" array not found.');
		}

	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(disposable2);
}

// This method is called when your extension is deactivated
export function deactivate() {}