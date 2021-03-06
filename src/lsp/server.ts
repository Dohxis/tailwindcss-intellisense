/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  CompletionItem,
  InitializeParams,
  InitializeResult,
  CompletionParams,
  CompletionList,
  Hover,
  TextDocumentPositionParams,
  DidChangeConfigurationNotification,
  CodeActionParams,
  CodeAction,
} from 'vscode-languageserver'
import getTailwindState from '../class-names/index'
import { State, Settings, EditorState } from './util/state'
import {
  provideCompletions,
  resolveCompletionItem,
} from './providers/completionProvider'
import { provideHover } from './providers/hoverProvider'
import { URI } from 'vscode-uri'
import { getDocumentSettings } from './util/getDocumentSettings'
import {
  provideDiagnostics,
  updateAllDiagnostics,
  clearAllDiagnostics,
} from './providers/diagnostics/diagnosticsProvider'
import { createEmitter } from '../lib/emitter'
import { provideCodeActions } from './providers/codeActions/codeActionProvider'
import { registerDocumentColorProvider } from './providers/documentColorProvider'

let connection = createConnection(ProposedFeatures.all)
const state: State = { enabled: false, emitter: createEmitter(connection) }
let documents = new TextDocuments()
let workspaceFolder: string | null

const defaultSettings: Settings = {
  emmetCompletions: false,
  includeLanguages: {},
  validate: true,
  lint: {
    cssConflict: 'warning',
    invalidApply: 'error',
    invalidScreen: 'error',
    invalidVariant: 'error',
    invalidConfigPath: 'error',
    invalidTailwindDirective: 'error',
  },
}
let globalSettings: Settings = defaultSettings
let documentSettings: Map<string, Settings> = new Map()

documents.onDidOpen((event) => {
  getDocumentSettings(state, event.document)
})
documents.onDidClose((event) => {
  documentSettings.delete(event.document.uri)
})
documents.onDidChangeContent((change) => {
  if (!state.enabled) return
  provideDiagnostics(state, change.document)
})
documents.listen(connection)

connection.onInitialize(
  async (params: InitializeParams): Promise<InitializeResult> => {
    const capabilities = params.capabilities

    state.editor = {
      connection,
      documents,
      documentSettings,
      globalSettings,
      userLanguages:
        params.initializationOptions &&
        params.initializationOptions.userLanguages
          ? params.initializationOptions.userLanguages
          : {},
      capabilities: {
        configuration:
          capabilities.workspace && !!capabilities.workspace.configuration,
        diagnosticRelatedInformation:
          capabilities.textDocument &&
          capabilities.textDocument.publishDiagnostics &&
          capabilities.textDocument.publishDiagnostics.relatedInformation,
      },
    }

    const tailwindState = await getTailwindState(
      params.rootPath || URI.parse(params.rootUri).path,
      {
        // @ts-ignore
        onChange: (newState: State): void => {
          if (newState && !newState.error) {
            Object.assign(state, newState, { enabled: true })
            connection.sendNotification('tailwindcss/configUpdated', [
              state.configPath,
              state.config,
              state.plugins,
            ])
            updateAllDiagnostics(state)
          } else {
            state.enabled = false
            if (newState && newState.error) {
              const payload: {
                message: string
                file?: string
                line?: number
              } = { message: newState.error.message }
              const lines = newState.error.stack.toString().split('\n')
              const match = /^(?<file>.*?):(?<line>[0-9]+)$/.exec(lines[0])
              if (match) {
                payload.file = match.groups.file
                payload.line = parseInt(match.groups.line, 10)
              }
              connection.sendNotification('tailwindcss/configError', [payload])
            }
            clearAllDiagnostics(state)
            // TODO
            // connection.sendNotification('tailwindcss/configUpdated', [null])
          }
        },
      }
    )

    if (tailwindState) {
      Object.assign(state, tailwindState, { enabled: true })
    } else {
      state.enabled = false
    }

    return {
      capabilities: {
        // textDocumentSync: {
        //   openClose: true,
        //   change: TextDocumentSyncKind.None
        // },
        textDocumentSync: documents.syncKind,
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: [
            // class attributes
            '"',
            "'",
            '`',
            // between class names
            ' ',
            // @apply and emmet-style
            '.',
            // config/theme helper
            '[',
            // TODO: restart server if separater changes?
            typeof state.separator === 'undefined' ? ':' : state.separator,
          ],
        },
        hoverProvider: true,
        codeActionProvider: true,
      },
    }
  }
)

connection.onInitialized &&
  connection.onInitialized(async () => {
    if (state.editor.capabilities.configuration) {
      connection.client.register(
        DidChangeConfigurationNotification.type,
        undefined
      )
    }

    connection.sendNotification('tailwindcss/configUpdated', [
      state.configPath,
      state.config,
      state.plugins,
    ])

    registerDocumentColorProvider(state)
  })

connection.onDidChangeConfiguration((change) => {
  if (state.editor.capabilities.configuration) {
    // Reset all cached document settings
    state.editor.documentSettings.clear()
  } else {
    state.editor.globalSettings = <Settings>(
      (change.settings.tailwindCSS || defaultSettings)
    )
  }

  updateAllDiagnostics(state)
})

connection.onCompletion(
  (params: CompletionParams): Promise<CompletionList> => {
    if (!state.enabled) return null
    return provideCompletions(state, params)
  }
)

connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (!state.enabled) return null
    return resolveCompletionItem(state, item)
  }
)

connection.onHover(
  (params: TextDocumentPositionParams): Hover => {
    if (!state.enabled) return null
    return provideHover(state, params)
  }
)

connection.onCodeAction(
  (params: CodeActionParams): Promise<CodeAction[]> => {
    if (!state.enabled) return null
    return provideCodeActions(state, params)
  }
)

connection.listen()
