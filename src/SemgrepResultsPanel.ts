import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Defines the structure for a result item.
 */
interface SemgrepResult {
    check_id: string;
    path: string;
    start: { line: number; col: number; };
    end: { line: number; col: number; };
    extra: {
        message: string;
        severity: string;
        lines: string;
    };
    // Unique ID for internal tracking in the extension/webview
    id: string; 
}

/**
 * Manages the Semgrep Triage Webview Panel.
 */
export class SemgrepResultsPanel {
    public static currentPanel: SemgrepResultsPanel | undefined;
    public static readonly viewType = 'semgrepResults';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _results: {
        untriaged: SemgrepResult[],
        issues: SemgrepResult[],
        falsePositives: SemgrepResult[]
    };
    private _rootPath: string; // Used to normalize paths

    /**
     * Initializes the panel with results.
     */
    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, results: any[], filePath: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Determine the project root to make paths relative
        this._rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(filePath);

        // Map and prepare results, adding a unique ID for tracking
        this._results = {
            untriaged: results.map((r, index) => ({ ...r, id: `item-${index}` })),
            issues: [],
            falsePositives: []
        };
        
        // Set the webview's initial html content
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'initialized':
                        this._sendInitialData();
                        return;
                    case 'triage':
                        this._handleTriage(message.data);
                        return;
                    case 'goTo':
                        this._goToLocation(message.data);
                        return;
                    case 'save':
                        this._saveProgress(message.data);
                        return;
                    case 'load':
                        this._loadProgress();
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * Creates a new panel or shows the existing one.
     */
    public static createOrShow(extensionUri: vscode.Uri, results: any[], filePath: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (SemgrepResultsPanel.currentPanel) {
            SemgrepResultsPanel.currentPanel._panel.reveal(column);
            // Re-initialize with new data if a new file is loaded
            SemgrepResultsPanel.currentPanel = new SemgrepResultsPanel(
                SemgrepResultsPanel.currentPanel._panel, extensionUri, results, filePath
            );
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            SemgrepResultsPanel.viewType,
            'Semgrep Triage Results',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        SemgrepResultsPanel.currentPanel = new SemgrepResultsPanel(panel, extensionUri, results, filePath);
    }

    /**
     * Sends the initial set of data to the webview.
     */
    private _sendInitialData() {
        this._panel.webview.postMessage({
            command: 'updateView',
            data: this._results
        });
    }

    /**
     * Handles moving an item between triage categories.
     */
    private _handleTriage(data: { id: string, from: 'untriaged' | 'issues' | 'falsePositives', to: 'issues' | 'falsePositives' | 'untriaged' }) {
        const { id, from, to } = data;

        const index = this._results[from].findIndex(r => r.id === id);
        if (index === -1) return; // Not found

        const item = this._results[from].splice(index, 1)[0];
        this._results[to].push(item);

        // Update the webview
        this._panel.webview.postMessage({
            command: 'updateView',
            data: this._results
        });
    }

    /**
     * Opens the file and navigates to the specified location.
     */
    private async _goToLocation(data: { path: string, line: number, col: number }) {
        try {
            // Resolve the path relative to the workspace or the initial file path
            const filePath = path.isAbsolute(data.path) ? data.path : path.join(this._rootPath, data.path);
            const uri = vscode.Uri.file(filePath);
            
            const document = await vscode.workspace.openTextDocument(uri);
            const startLine = Math.max(0, data.line - 1); // VS Code is 0-indexed
            const startCol = Math.max(0, data.col - 1);

            const position = new vscode.Position(startLine, startCol);
            const range = new vscode.Range(position, position);

            await vscode.window.showTextDocument(document, {
                selection: range,
                viewColumn: vscode.ViewColumn.One // Open in the first column
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Could not open file: ${data.path}. (Is the path correct?)`);
        }
    }

    /**
     * Prompts for a file and saves the current state.
     */
    private async _saveProgress(data: any) {
        try {
            const fileUri = await vscode.window.showSaveDialog({
                filters: { 'JSON': ['json'] },
                defaultUri: vscode.Uri.file(path.join(this._rootPath, 'semgrep_triage_progress.json'))
            });

            if (fileUri) {
                const content = JSON.stringify(data, null, 2);
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content));
                vscode.window.showInformationMessage('Semgrep triage progress saved successfully!');
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to save progress: ${e.message}`);
        }
    }

    /**
     * Prompts for a file and loads a saved state.
     */
    private async _loadProgress() {
        try {
            const uri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'JSON Files': ['json'] }
            });

            if (uri && uri.length > 0) {
                const fileData = await vscode.workspace.fs.readFile(uri[0]);
                const content = Buffer.from(fileData).toString('utf8');
                const loadedData = JSON.parse(content);

                // Basic validation
                if (true || (loadedData.untriaged && loadedData.issues && loadedData.falsePositives)) {
                    this._results = loadedData;
                    this._panel.webview.postMessage({
                        command: 'updateView',
                        data: this._results
                    });
                    vscode.window.showInformationMessage('Semgrep triage progress loaded successfully!');
                } else {
                    vscode.window.showErrorMessage('Invalid progress file structure.');
                }
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to load progress: ${e.message}`);
        }
    }

    /**
     * Cleans up resources when the panel is closed.
     */
    public dispose() {
        SemgrepResultsPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * Gets the HTML content for the Webview.
     */
    private _getHtmlForWebview(webview: vscode.Webview): string {
        // Local path to the main script run in the webview
        const scriptPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js');
        const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

        // Local path to CSS styles
        const stylePathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css');
        const styleUri = webview.asWebviewUri(stylePathOnDisk);

        // Use a Content Security Policy
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Semgrep Triage</title>
                <link href="${styleUri}" rel="stylesheet">
                <style>
                    /* Basic inline styles for clarity and robust tables */
                    body { font-family: sans-serif; padding: 20px; }
                    .header-buttons { margin-bottom: 20px; }
                    .header-buttons button { margin-right: 10px; padding: 8px 15px; cursor: pointer; }
                    
                    h2 { border-bottom: 1px solid var(--vscode-dropdown-border); padding-bottom: 5px; margin-top: 30px; }
                    
                    .result-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    .result-table th, .result-table td { 
                        border: 1px solid var(--vscode-editorGroup-border); 
                        padding: 8px; 
                        text-align: left;
                        vertical-align: top;
                    }
                    .result-table th { background-color: var(--vscode-editorGroupHeader-tabsBackground); }
                    .lines-cell { font-family: 'Consolas', 'Courier New', monospace; font-size: 0.9em; white-space: pre-wrap; }
                    .actions button { margin-right: 5px; cursor: pointer; padding: 5px 10px; }
                    
                    /* Severity colors */
                    .severity-ERROR { color: var(--vscode-errorForeground); font-weight: bold; }
                    .severity-WARNING { color: var(--vscode-list-warningForeground); font-weight: bold; }
                    .severity-INFO { color: var(--vscode-list-deemphasizedForeground); }
                </style>
            </head>
            <body>
                <h1>Semgrep Triage Tool</h1>
                <div class="header-buttons">
                    <button id="save-progress">💾 Save Progress</button>
                    <button id="load-progress">📂 Load Progress</button>
                </div>
                
                <div id="loading-message" style="display:none;">Loading data...</div>

                <div id="app-container">
                    
                    <h2 id="untriaged-heading">Untriaged Items (<span id="untriaged-count">0</span>)</h2>
                    <table id="untriaged-table" class="result-table"></table>

                    <h2 id="issues-heading">Issues (<span id="issues-count">0</span>)</h2>
                    <table id="issues-table" class="result-table"></table>

                    <h2 id="falsePositives-heading">False Positives (<span id="falsePositives-count">0</span>)</h2>
                    <table id="falsePositives-table" class="result-table"></table>

                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    let results = {
                        untriaged: [],
                        issues: [],
                        falsePositives: []
                    };
                    
                    // --- Utility Functions ---

                    /**
                     * Renders a single table row (tr)
                     */
                    function createRow(item, currentCategory) {
                        const tr = document.createElement('tr');
                        
                        // check_id
                        tr.innerHTML += \`<td title="\${item.check_id}">\${item.check_id}</td>\`;
                        
                        // message
                        tr.innerHTML += \`<td title="\${item.extra.message}">\${item.extra.message}</td>\`;
                        
                        // severity
                        tr.innerHTML += \`<td class="severity-\${item.extra.severity}">\${item.extra.severity}</td>\`;
                        
                        // path
                        tr.innerHTML += \`<td title="\${item.path}">\${item.path}</td>\`;
                        
                        // lines
                        tr.innerHTML += \`<td class="lines-cell">\${item.extra.lines}</td>\`;

                        // Actions (buttons)
                        const actionsTd = document.createElement('td');
                        actionsTd.classList.add('actions');
                        
                        // Go To Button
                        const goToBtn = document.createElement('button');
                        goToBtn.textContent = 'Go To';
                        goToBtn.onclick = () => {
                            vscode.postMessage({
                                command: 'goTo',
                                data: {
                                    path: item.path,
                                    line: item.start.line,
                                    col: item.start.col
                                }
                            });
                        };
                        actionsTd.appendChild(goToBtn);

                        // Issue Button (show only if NOT already in Issues)
                        if (currentCategory !== 'issues') {
                            const issueBtn = document.createElement('button');
                            issueBtn.textContent = 'Issue';
                            issueBtn.onclick = () => triageItem(item.id, currentCategory, 'issues');
                            actionsTd.appendChild(issueBtn);
                        }
                        
                        // False Positive Button (show only if NOT already in False Positives)
                        if (currentCategory !== 'falsePositives') {
                            const fpBtn = document.createElement('button');
                            fpBtn.textContent = 'False Positive';
                            fpBtn.onclick = () => triageItem(item.id, currentCategory, 'falsePositives');
                            actionsTd.appendChild(fpBtn);
                        }

                        // Untriaged Button (show only if NOT already in Untriaged)
                        if (currentCategory !== 'untriaged') {
                            const untriagedBtn = document.createElement('button');
                            untriagedBtn.textContent = 'Untriaged';
                            untriagedBtn.onclick = () => triageItem(item.id, currentCategory, 'untriaged');
                            actionsTd.appendChild(untriagedBtn);
                        }
                        
                        tr.appendChild(actionsTd);
                        return tr;
                    }

                    /**
                     * Renders a full table
                     */
                    function renderTable(category) {
                        const table = document.getElementById(\`\${category}-table\`);
                        const countSpan = document.getElementById(\`\${category}-count\`);
                        
                        // Clear existing content
                        table.innerHTML = ''; 

                        // Update count
                        countSpan.textContent = results[category].length;

                        // Create header row
                        const thead = table.createTHead();
                        const headerRow = thead.insertRow();
                        const headers = ['check_id', 'message', 'severity', 'path', 'lines', 'Actions'];
                        headers.forEach(text => {
                            const th = document.createElement('th');
                            th.textContent = text;
                            headerRow.appendChild(th);
                        });

                        // Create body
                        const tbody = document.createElement('tbody');
                        results[category].forEach(item => {
                            tbody.appendChild(createRow(item, category));
                        });
                        table.appendChild(tbody);
                    }

                    /**
                     * Renders all tables
                     */
                    function renderAllTables() {
                        renderTable('untriaged');
                        renderTable('issues');
                        renderTable('falsePositives');
                    }

                    /**
                     * Sends a triage message to the extension
                     */
                    function triageItem(id, from, to) {
                        vscode.postMessage({
                            command: 'triage',
                            data: { id, from, to }
                        });
                    }

                    // --- Event Listeners and Handlers ---

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.command) {
                            case 'updateView':
                                // Received new data from extension (initial load, triage, or progress load)
                                results = message.data;
                                renderAllTables();
                                break;
                        }
                    });

                    document.getElementById('save-progress').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'save',
                            data: results // Send current state to extension for saving
                        });
                    });

                    document.getElementById('load-progress').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'load' // Request extension to prompt user and load file
                        });
                    });

                    // Inform the extension that the webview is ready to receive initial data
                    vscode.postMessage({ command: 'initialized' });
                </script>
            </body>
            </html>`;
    }
}

/**
 * A utility function to generate a random string for the Content Security Policy nonce.
 */
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}