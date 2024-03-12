import { IPythonMode } from 'pyright-internal/analyzer/sourceFile';
import { Uri } from 'pyright-internal/common/uri/uri';
import { PyrightServer } from 'pyright-internal/server';
import {
    CancellationToken,
    DidChangeNotebookDocumentParams,
    DidCloseNotebookDocumentParams,
    DidOpenNotebookDocumentParams,
    DidOpenTextDocumentParams,
    DidSaveNotebookDocumentParams,
    DocumentUri,
    InitializeParams,
    InitializeResult,
    NotebookCell,
    NotebookDocument,
} from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';

export class LibroAnalyzer extends PyrightServer {
    protected readonly notebookDocuments = new Map<string, NotebookDocument>();
    protected readonly notebookCellMap = new Map<DocumentUri, [NotebookCell, NotebookDocument]>();

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

    protected override initialize(
        params: InitializeParams,
        supportedCommands: string[],
        supportedCodeActions: string[]
    ): InitializeResult {
        const result = super.initialize(params, supportedCommands, supportedCodeActions);
        // params.capabilities.notebookDocument?.synchronization
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

    protected updateCellMap(notebookDocument: NotebookDocument): void {
        for (const cell of notebookDocument.cells) {
            this.notebookCellMap.set(cell.document, [cell, notebookDocument]);
        }
    }

    protected async onDidOpenNotebookDocument(params: DidOpenNotebookDocumentParams) {
        const uri = this.decodeUri(params.notebookDocument.uri);
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
            this.onDidOpenTextDocument({ textDocument: cell }, IPythonMode.CellDocs, chainedFilePath);
            chainedFilePath = this.decodeUri(cell.uri);
        }

        this.updateCellMap(params.notebookDocument);
    }
    protected onDidChangeNotebookDocument(params: DidChangeNotebookDocumentParams) {
        this.recordUserInteractionTime();

        const uri = this.decodeUri(params.notebookDocument.uri);
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
                            ? this.decodeUri(chainedFile?.document)
                            : undefined;
                        this.onDidOpenTextDocument({ textDocument: open }, IPythonMode.CellDocs, chainedFilePath);
                    }
                }
                // Additional closed cell text documents.
                if (changedCells.structure.didClose) {
                    for (const close of changedCells.structure.didClose) {
                        this.onDidCloseTextDocument({ textDocument: close });
                    }
                }
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
                for (const cellTextDocument of changedCells.textContent) {
                    this.onDidChangeTextDocument(
                        {
                            textDocument: cellTextDocument.document,
                            contentChanges: cellTextDocument.changes,
                        },
                        IPythonMode.CellDocs
                    );
                }
            }
        }
    }
    protected onDidSaveNotebookDocument(params: DidSaveNotebookDocumentParams) {}
    protected onDidCloseNotebookDocument(params: DidCloseNotebookDocumentParams) {
        const uri = this.decodeUri(params.notebookDocument.uri);
        const notebookDocument = this.notebookDocuments.get(uri.key);
        if (notebookDocument === undefined) {
            return;
        }
        for (const cellTextDocument of params.cellTextDocuments) {
            this.onDidCloseTextDocument({ textDocument: cellTextDocument });
        }
        this.notebookDocuments.delete(uri.key);
        for (const cell of notebookDocument.cells) {
            this.notebookCellMap.delete(cell.document);
        }
    }

    protected override async onDidOpenTextDocument(
        params: DidOpenTextDocumentParams,
        ipythonMode?: IPythonMode,
        chainedFileUri?: Uri
    ): Promise<void> {
        const uri = this.decodeUri(params.textDocument.uri);

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

    protected override onShutdown(token: CancellationToken): Promise<void> {
        this.notebookCellMap.clear();
        this.notebookDocuments.clear();
        return super.onShutdown(token);
    }
}
