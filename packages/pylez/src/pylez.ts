import { AnalysisResults } from 'pyright-internal/analyzer/analysis';
import { CacheManager } from 'pyright-internal/analyzer/cacheManager';
import { ImportResolver } from 'pyright-internal/analyzer/importResolver';
import { isPythonBinary } from 'pyright-internal/analyzer/pythonPathUtils';
import { IPythonMode } from 'pyright-internal/analyzer/sourceFile';
import { BackgroundAnalysis } from 'pyright-internal/backgroundAnalysis';
import { BackgroundAnalysisBase } from 'pyright-internal/backgroundAnalysisBase';
import { CommandController } from 'pyright-internal/commands/commandController';
import { getCancellationFolderName } from 'pyright-internal/common/cancellationUtils';
import { ConfigOptions, SignatureDisplayType } from 'pyright-internal/common/configOptions';
import { ConsoleWithLogLevel, convertLogLevel, LogLevel } from 'pyright-internal/common/console';
import { isDebugMode, isDefined, isString } from 'pyright-internal/common/core';
import { resolvePathWithEnvVariables } from 'pyright-internal/common/envVarUtils';
import { FileBasedCancellationProvider } from 'pyright-internal/common/fileBasedCancellationUtils';
import { FileSystem } from 'pyright-internal/common/fileSystem';
import { FullAccessHost } from 'pyright-internal/common/fullAccessHost';
import { Host } from 'pyright-internal/common/host';
import { ServerSettings } from 'pyright-internal/common/languageServerInterface';
import { ProgressReporter } from 'pyright-internal/common/progressReporter';
import {
    createFromRealFileSystem,
    RealTempFile,
    WorkspaceFileWatcherProvider,
} from 'pyright-internal/common/realFileSystem';
import { ServiceProvider } from 'pyright-internal/common/serviceProvider';
import { createServiceProvider } from 'pyright-internal/common/serviceProviderExtensions';
import { Uri } from 'pyright-internal/common/uri/uri';
import { getRootUri } from 'pyright-internal/common/uri/uriUtils';
import { TextDocument } from 'pyright-internal/exports';
import { LanguageServerBase } from 'pyright-internal/languageServerBase';
import { CodeActionProvider } from 'pyright-internal/languageService/codeActionProvider';
import { PyrightFileSystem } from 'pyright-internal/pyrightFileSystem';
import { WellKnownWorkspaceKinds, Workspace } from 'pyright-internal/workspaceFactory';

import {
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    Command,
    Connection,
    ExecuteCommandParams,
    WorkDoneProgressServerReporter,
} from 'vscode-languageserver';
import {
    CancellationToken,
    DidChangeNotebookDocumentParams,
    DidCloseNotebookDocumentParams,
    DidOpenNotebookDocumentParams,
    DidOpenTextDocumentParams,
    DidSaveNotebookDocumentParams,
    InitializeParams,
    InitializeResult,
    NotebookCell,
    NotebookDocument,
} from 'vscode-languageserver-protocol';
import { NotebookCellScheme } from './constant';

const maxAnalysisTimeInForeground = { openFilesTimeInMs: 50, noOpenFilesTimeInMs: 200 };

export class Pylez extends LanguageServerBase {
    protected readonly notebookDocuments = new Map<string, NotebookDocument>();

    private _controller: CommandController;

    constructor(connection: Connection, maxWorkers: number, realFileSystem?: FileSystem) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const version = require('../package.json').version || '';

        const tempFile = new RealTempFile();
        const console = new ConsoleWithLogLevel(connection.console);
        const fileWatcherProvider = new WorkspaceFileWatcherProvider();
        const fileSystem = realFileSystem ?? createFromRealFileSystem(tempFile, console, fileWatcherProvider);
        const pyrightFs = new PyrightFileSystem(fileSystem);
        const cacheManager = new CacheManager(maxWorkers);

        const serviceProvider = createServiceProvider(pyrightFs, tempFile, console, cacheManager);

        // When executed from CLI command (pyright-langserver), __rootDirectory is
        // already defined. When executed from VSCode extension, rootDirectory should
        // be __dirname.
        const rootDirectory: Uri = getRootUri(serviceProvider) || Uri.file(__dirname, serviceProvider);
        const realPathRoot = pyrightFs.realCasePath(rootDirectory);

        super(
            {
                productName: 'Pylez',
                rootDirectory: realPathRoot,
                version,
                serviceProvider,
                fileWatcherHandler: fileWatcherProvider,
                cancellationProvider: new FileBasedCancellationProvider('bg'),
                maxAnalysisTimeInForeground,
                supportedCodeActions: [CodeActionKind.QuickFix, CodeActionKind.SourceOrganizeImports],
            },
            connection
        );

        this._controller = new CommandController(this);
    }

    async getSettings(workspace: Workspace): Promise<ServerSettings> {
        const serverSettings: ServerSettings = {
            watchForSourceChanges: true,
            watchForLibraryChanges: true,
            watchForConfigChanges: true,
            openFilesOnly: true,
            useLibraryCodeForTypes: true,
            disableLanguageServices: false,
            disableTaggedHints: false,
            disableOrganizeImports: false,
            typeCheckingMode: 'standard',
            diagnosticSeverityOverrides: {},
            logLevel: LogLevel.Info,
            autoImportCompletions: true,
            functionSignatureDisplay: SignatureDisplayType.formatted,
        };

        try {
            const workspaces = this.workspaceFactory.getNonDefaultWorkspaces(WellKnownWorkspaceKinds.Regular);

            const pythonSection = await this.getConfiguration(workspace.rootUri, 'python');
            if (pythonSection) {
                const pythonPath = pythonSection.pythonPath;
                if (pythonPath && isString(pythonPath) && !isPythonBinary(pythonPath)) {
                    serverSettings.pythonPath = resolvePathWithEnvVariables(workspace, pythonPath, workspaces);
                }

                const venvPath = pythonSection.venvPath;
                if (venvPath && isString(venvPath)) {
                    serverSettings.venvPath = resolvePathWithEnvVariables(workspace, venvPath, workspaces);
                }
            }

            const pythonAnalysisSection = await this.getConfiguration(workspace.rootUri, 'python.analysis');
            if (pythonAnalysisSection) {
                const typeshedPaths = pythonAnalysisSection.typeshedPaths;
                if (typeshedPaths && Array.isArray(typeshedPaths) && typeshedPaths.length > 0) {
                    const typeshedPath = typeshedPaths[0];
                    if (typeshedPath && isString(typeshedPath)) {
                        serverSettings.typeshedPath = resolvePathWithEnvVariables(workspace, typeshedPath, workspaces);
                    }
                }

                const stubPath = pythonAnalysisSection.stubPath;
                if (stubPath && isString(stubPath)) {
                    serverSettings.stubPath = resolvePathWithEnvVariables(workspace, stubPath, workspaces);
                }

                const diagnosticSeverityOverrides = pythonAnalysisSection.diagnosticSeverityOverrides;
                if (diagnosticSeverityOverrides) {
                    for (const [name, value] of Object.entries(diagnosticSeverityOverrides)) {
                        const ruleName = this.getDiagnosticRuleName(name);
                        const severity = this.getSeverityOverrides(value as string | boolean);
                        if (ruleName && severity) {
                            serverSettings.diagnosticSeverityOverrides![ruleName] = severity!;
                        }
                    }
                }

                if (pythonAnalysisSection.diagnosticMode !== undefined) {
                    serverSettings.openFilesOnly = this.isOpenFilesOnly(pythonAnalysisSection.diagnosticMode);
                } else if (pythonAnalysisSection.openFilesOnly !== undefined) {
                    serverSettings.openFilesOnly = !!pythonAnalysisSection.openFilesOnly;
                }

                if (pythonAnalysisSection.useLibraryCodeForTypes !== undefined) {
                    serverSettings.useLibraryCodeForTypes = !!pythonAnalysisSection.useLibraryCodeForTypes;
                }

                serverSettings.logLevel = convertLogLevel(pythonAnalysisSection.logLevel);
                serverSettings.autoSearchPaths = !!pythonAnalysisSection.autoSearchPaths;

                const extraPaths = pythonAnalysisSection.extraPaths;
                if (extraPaths && Array.isArray(extraPaths) && extraPaths.length > 0) {
                    serverSettings.extraPaths = extraPaths
                        .filter((p) => p && isString(p))
                        .map((p) => resolvePathWithEnvVariables(workspace, p, workspaces))
                        .filter(isDefined);
                }

                serverSettings.includeFileSpecs = this._getStringValues(pythonAnalysisSection.include);
                serverSettings.excludeFileSpecs = this._getStringValues(pythonAnalysisSection.exclude);
                serverSettings.ignoreFileSpecs = this._getStringValues(pythonAnalysisSection.ignore);

                if (pythonAnalysisSection.typeCheckingMode !== undefined) {
                    serverSettings.typeCheckingMode = pythonAnalysisSection.typeCheckingMode;
                }

                if (pythonAnalysisSection.autoImportCompletions !== undefined) {
                    serverSettings.autoImportCompletions = pythonAnalysisSection.autoImportCompletions;
                }

                if (
                    serverSettings.logLevel === LogLevel.Log &&
                    pythonAnalysisSection.logTypeEvaluationTime !== undefined
                ) {
                    serverSettings.logTypeEvaluationTime = pythonAnalysisSection.logTypeEvaluationTime;
                }

                if (pythonAnalysisSection.typeEvaluationTimeThreshold !== undefined) {
                    serverSettings.typeEvaluationTimeThreshold = pythonAnalysisSection.typeEvaluationTimeThreshold;
                }
            } else {
                serverSettings.autoSearchPaths = true;
            }

            const pyrightSection = await this.getConfiguration(workspace.rootUri, 'pylez');
            if (pyrightSection) {
                if (pyrightSection.openFilesOnly !== undefined) {
                    serverSettings.openFilesOnly = !!pyrightSection.openFilesOnly;
                }

                if (pyrightSection.useLibraryCodeForTypes !== undefined) {
                    serverSettings.useLibraryCodeForTypes = !!pyrightSection.useLibraryCodeForTypes;
                }

                serverSettings.disableLanguageServices = !!pyrightSection.disableLanguageServices;
                serverSettings.disableTaggedHints = !!pyrightSection.disableTaggedHints;
                serverSettings.disableOrganizeImports = !!pyrightSection.disableOrganizeImports;

                const typeCheckingMode = pyrightSection.typeCheckingMode;
                if (typeCheckingMode && isString(typeCheckingMode)) {
                    serverSettings.typeCheckingMode = typeCheckingMode;
                }
            }
        } catch (error) {
            this.console.error(`Error reading settings: ${error}`);
        }
        return serverSettings;
    }

    createBackgroundAnalysis(serviceId: string): BackgroundAnalysisBase | undefined {
        if (isDebugMode() || !getCancellationFolderName()) {
            // Don't do background analysis if we're in debug mode or an old client
            // is used where cancellation is not supported.
            return undefined;
        }

        return new BackgroundAnalysis(this.serverOptions.serviceProvider);
    }

    override getContainingWorkspacesForFile(fileUri: Uri): Promise<Workspace[]> {
        if (fileUri.scheme === NotebookCellScheme) {
            fileUri = Uri.file(fileUri.getPath(), this.serverOptions.serviceProvider);
        }
        return this.workspaceFactory.getContainingWorkspacesForFile(fileUri);
    }

    override getWorkspaceForFile(fileUri: Uri, pythonPath?: Uri): Promise<Workspace> {
        if (fileUri.scheme === NotebookCellScheme) {
            fileUri = Uri.file(fileUri.getPath(), this.serverOptions.serviceProvider);
        }
        return this.workspaceFactory.getWorkspaceForFile(fileUri, pythonPath);
    }

    protected override createHost() {
        return new FullAccessHost(this.serverOptions.serviceProvider);
    }

    protected override createImportResolver(
        serviceProvider: ServiceProvider,
        options: ConfigOptions,
        host: Host
    ): ImportResolver {
        const importResolver = new ImportResolver(serviceProvider, options, host);

        // In case there was cached information in the file system related to
        // import resolution, invalidate it now.
        importResolver.invalidateCache();

        return importResolver;
    }

    protected executeCommand(params: ExecuteCommandParams, token: CancellationToken): Promise<any> {
        return this._controller.execute(params, token);
    }

    protected isLongRunningCommand(command: string): boolean {
        return this._controller.isLongRunningCommand(command);
    }

    protected isRefactoringCommand(command: string): boolean {
        return this._controller.isRefactoringCommand(command);
    }

    protected async executeCodeAction(
        params: CodeActionParams,
        token: CancellationToken
    ): Promise<(Command | CodeAction)[] | undefined | null> {
        this.recordUserInteractionTime();

        const uri = Uri.parse(params.textDocument.uri, this.serverOptions.serviceProvider);
        const workspace = await this.getWorkspaceForFile(uri);
        return CodeActionProvider.getCodeActionsForPosition(workspace, uri, params.range, params.context.only, token);
    }

    protected createProgressReporter(): ProgressReporter {
        // The old progress notifications are kept for backwards compatibility with
        // clients that do not support work done progress.

        let workDoneProgress: Promise<WorkDoneProgressServerReporter> | undefined;
        return {
            isEnabled: (data: AnalysisResults) => true,
            begin: () => {
                if (this.client.hasWindowProgressCapability) {
                    workDoneProgress = this.connection.window.createWorkDoneProgress();
                    workDoneProgress
                        .then((progress) => {
                            progress.begin('');
                        })
                        .ignoreErrors();
                } else {
                    this.connection.sendNotification('pyright/beginProgress');
                }
            },
            report: (message: string) => {
                if (workDoneProgress) {
                    workDoneProgress
                        .then((progress) => {
                            progress.report(message);
                        })
                        .ignoreErrors();
                } else {
                    this.connection.sendNotification('pyright/reportProgress', message);
                }
            },
            end: () => {
                if (workDoneProgress) {
                    workDoneProgress
                        .then((progress) => {
                            progress.done();
                        })
                        .ignoreErrors();
                    workDoneProgress = undefined;
                } else {
                    this.connection.sendNotification('pyright/endProgress');
                }
            },
        };
    }

    protected override setupConnection(supportedCommands: string[], supportedCodeActions: string[]): void {
        super.setupConnection(supportedCommands, supportedCodeActions);
        this.connection.notebooks.synchronization.onDidOpenNotebookDocument(async (params) =>
            this.onDidOpenNotebookDocument(params)
        );
        this.connection.notebooks.synchronization.onDidChangeNotebookDocument(async (params) =>
            this.onDidChangeNotebookDocument(params)
        );
        this.connection.notebooks.synchronization.onDidSaveNotebookDocument(async (params) =>
            this.onDidSaveNotebookDocument(params)
        );
        this.connection.notebooks.synchronization.onDidCloseNotebookDocument(async (params) =>
            this.onDidCloseNotebookDocument(params)
        );
    }

    protected override async initialize(
        params: InitializeParams,
        supportedCommands: string[],
        supportedCodeActions: string[]
    ): Promise<InitializeResult> {
        this.console.log('[pylez] initialize');
        const result = await super.initialize(params, supportedCommands, supportedCodeActions);
        result.capabilities.notebookDocumentSync = {
            notebookSelector: [
                {
                    notebook: { notebookType: '*' },
                    cells: [{ language: 'python' }],
                },
            ],
        };
        return result;
    }

    protected async onDidOpenNotebookDocument(params: DidOpenNotebookDocumentParams) {
        const uri = this.convertLspUriStringToUri(params.notebookDocument.uri);
        this.console.log(`[pylez] onDidOpenNotebookDocument: ${uri.toString()}`);
        let doc = this.notebookDocuments.get(uri.key);
        if (doc) {
            // We shouldn't get an open notebook document request for an already-opened doc.
            this.console.error(`Received redundant open notebook document command for ${uri}`);
        } else {
            doc = NotebookDocument.create(
                params.notebookDocument.uri,
                params.notebookDocument.notebookType,
                params.notebookDocument.version,
                params.notebookDocument.cells
            );
        }
        this.notebookDocuments.set(uri.key, doc);

        let chainedFilePath: Uri | undefined;
        for (const cell of params.cellTextDocuments) {
            await this.onDidOpenTextDocument({ textDocument: cell }, IPythonMode.CellDocs, chainedFilePath);
            chainedFilePath = this.convertLspUriStringToUri(cell.uri);
        }
    }
    protected async onDidChangeNotebookDocument(params: DidChangeNotebookDocumentParams) {
        this.recordUserInteractionTime();
        const uri = this.convertLspUriStringToUri(params.notebookDocument.uri);
        this.console.log(`[pylez] onDidChangeNotebookDocument: ${uri.toString()}`);
        const notebookDocument = this.notebookDocuments.get(uri.key);
        if (notebookDocument === undefined) {
            // We shouldn't get a change notebook request for a closed doc.
            this.console.error(`Received change notebook document command for closed file ${uri}`);
            return;
        }
        notebookDocument.version = params.notebookDocument.version;
        const change = params.change;
        if (change.metadata !== undefined) {
            notebookDocument.metadata = change.metadata;
        }

        if (change.cells !== undefined) {
            const changedCells = change.cells;
            if (changedCells.structure !== undefined) {
                const array = changedCells.structure.array;
                notebookDocument.cells.splice(
                    array.start,
                    array.deleteCount,
                    ...(array.cells !== undefined ? array.cells : [])
                );
                // Additional open cell text documents.
                if (changedCells.structure.didOpen !== undefined) {
                    for (const open of changedCells.structure.didOpen) {
                        const currentIndex = notebookDocument.cells.findIndex((item) => item.document === open.uri);
                        const chainedFile = currentIndex > 0 ? notebookDocument.cells[currentIndex - 1] : undefined;
                        const chainedFilePath = chainedFile?.document
                            ? this.convertLspUriStringToUri(chainedFile?.document)
                            : undefined;
                        await this.onDidOpenTextDocument({ textDocument: open }, IPythonMode.CellDocs, chainedFilePath);
                    }
                }
                // Additional closed cell text documents.
                if (changedCells.structure.didClose) {
                    for (const close of changedCells.structure.didClose) {
                        await this.onDidCloseTextDocument({ textDocument: close });
                    }
                }
                await this.updateChainedFile(uri);
            }
            if (changedCells.data !== undefined) {
                const cellUpdates: Map<string, NotebookCell> = new Map(
                    changedCells.data.map((cell) => [cell.document, cell])
                );
                for (let i = 0; i <= notebookDocument.cells.length; i++) {
                    const change = cellUpdates.get(notebookDocument.cells[i].document);
                    if (change !== undefined) {
                        cellUpdates.delete(change.document);
                        if (cellUpdates.size === 0) {
                            break;
                        }
                    }
                }
            }
            if (changedCells.textContent !== undefined) {
                for (const cellTextDocumentChange of changedCells.textContent) {
                    await this.onDidChangeTextDocument(
                        {
                            textDocument: cellTextDocumentChange.document,
                            contentChanges: cellTextDocumentChange.changes,
                        },
                        IPythonMode.CellDocs
                    );
                }
            }
        }
    }

    protected onDidSaveNotebookDocument(params: DidSaveNotebookDocumentParams) {}

    protected onDidCloseNotebookDocument(params: DidCloseNotebookDocumentParams) {
        const uri = this.convertLspUriStringToUri(params.notebookDocument.uri);
        this.console.log(`[pylez] onDidCloseNotebookDocument: ${uri.toString()}`);
        const notebookDocument = this.notebookDocuments.get(uri.key);
        if (notebookDocument === undefined) {
            return;
        }
        for (const cellTextDocument of params.cellTextDocuments) {
            this.onDidCloseTextDocument({ textDocument: cellTextDocument });
        }
        this.notebookDocuments.delete(uri.key);
    }

    protected override async onDidOpenTextDocument(
        params: DidOpenTextDocumentParams,
        ipythonMode?: IPythonMode,
        chainedFileUri?: Uri
    ): Promise<void> {
        const uri = this.convertLspUriStringToUri(params.textDocument.uri);
        this.console.log(`[pylez] onDidOpenTextDocument: ${uri.toString()}`);
        let doc = this.openFileMap.get(uri.key);
        if (doc) {
            // We shouldn't get an open text document request for an already-opened doc.
            this.console.error(`Received redundant open text document command for ${uri}`);
            TextDocument.update(doc, [{ text: params.textDocument.text }], params.textDocument.version);
        } else {
            doc = TextDocument.create(
                params.textDocument.uri,
                'python',
                params.textDocument.version,
                params.textDocument.text
            );
        }
        this.openFileMap.set(uri.key, doc);

        // Send this open to all the workspaces that might contain this file.
        const workspaces = await this.getContainingWorkspacesForFile(uri);
        workspaces.forEach((w) => {
            w.service.setFileOpened(
                uri,
                params.textDocument.version,
                params.textDocument.text,
                ipythonMode,
                chainedFileUri
            );
        });
    }

    protected async updateChainedFile(notebookUri: Uri) {
        const doc = this.notebookDocuments.get(notebookUri.key);
        if (!doc) {
            return;
        }
        if (this.hasSameCell(doc)) {
            return;
        }
        let chainedFileUri: Uri;
        for (const cell of doc.cells) {
            const cellUri = this.convertLspUriStringToUri(cell.document);
            // Send this change to all the workspaces that might contain this file.
            const workspaces = await this.getContainingWorkspacesForFile(cellUri);
            workspaces.forEach((w) => {
                w.service.updateChainedUri(cellUri, chainedFileUri);
            });
            chainedFileUri = cellUri;
        }
    }

    protected hasSameCell(doc: NotebookDocument) {
        return new Set(doc.cells.map((cell) => cell.document)).size !== doc.cells.length;
    }

    protected override onShutdown(token: CancellationToken): Promise<void> {
        this.notebookDocuments.clear();
        return super.onShutdown(token);
    }

    private _getStringValues(values: any) {
        if (!values || !Array.isArray(values) || values.length === 0) {
            return [];
        }

        return values.filter((p) => p && isString(p)) as string[];
    }
}
