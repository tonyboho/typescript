import { fork } from "node:child_process"
import path from "node:path"

export type TsServerMessage = {
    body? : unknown,
    type? : string,
    command? : string,
    event? : string,
    message? : string,
    request_seq? : number
    success? : boolean
}

export type TsServerResponse = TsServerMessage

export type TsServerDiagnostic = {
    start : {
        line : number,
        offset : number
    },
    end : {
        line : number,
        offset : number
    },
    text : string,
    code : number,
    category : string,
    source? : string
}

export type TypeScriptServerSession = {
    change : (args: {
        file : string,
        line : number,
        offset : number,
        endLine : number,
        endOffset : number,
        insertString : string
    }) => Promise<void>,
    close : () => Promise<void>,
    getDiagnostics : (files: string[]) => Promise<TsServerDiagnostic[]>,
    open : (args: {
        file : string,
        fileContent : string,
        projectRootPath : string
    }) => Promise<void>
}

export async function runTypeScriptServerSession<T>(
    fixtureDirectory: string,
    runner: (session: TypeScriptServerSession) => Promise<T>
): Promise<T> {
    const tsserverFile = path.join(fixtureDirectory, "node_modules", "typescript", "lib", "tsserver.js")
    const server       = fork(tsserverFile, [
        "--allowLocalPluginLoads",
        "--useNodeIpc"
    ], {
        cwd    : fixtureDirectory,
        silent : true
    })

    const pendingResponses = new Map<number, (response: TsServerResponse) => void>()
    const pendingDiagnostics = new Map<number, {
        files : Set<string>,
        resolve : (diagnostics: TsServerDiagnostic[]) => void,
        reject : (error: Error) => void,
        collected : Map<string, TsServerDiagnostic[]>
    }>()
    let sequence           = 0

    server.on("message", (message: TsServerMessage) => {
        if (message.type === "event") {
            handleDiagnosticEvent(message)
            return
        }

        if (message.type !== "response" || message.request_seq === undefined) {
            return
        }

        pendingResponses.get(message.request_seq)?.(message)
        pendingResponses.delete(message.request_seq)
    })

    server.stdout?.on("data", () => {})

    const session: TypeScriptServerSession = {
        async open(args) {
            await sendRequest("open", {
                ...args,
                scriptKindName : "TS"
            })
        },

        async change(args) {
            await sendRequest("change", args)
        },

        async getDiagnostics(files) {
            return waitForDiagnostics(files)
        },

        async close() {
            await sendRequest("exit", {})
        }
    }

    try {
        return await runner(session)
    } finally {
        server.send({
            arguments : {},
            command   : "exit",
            seq       : ++sequence,
            type      : "request"
        })
        await waitForExit(server)
    }

    function waitForDiagnostics(files: string[]): Promise<TsServerDiagnostic[]> {
        const seq = ++sequence

        server.send({
            arguments : {
                delay : 0,
                files
            },
            command : "geterr",
            seq,
            type    : "request"
        })

        return new Promise<TsServerDiagnostic[]>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingDiagnostics.delete(seq)
                reject(new Error("Timed out waiting for tsserver diagnostics."))
            }, 10_000)

            pendingDiagnostics.set(seq, {
                collected : new Map(files.map((file) => [ file, [] ])),
                files     : new Set(files),
                reject,
                resolve   : (diagnostics) => {
                    clearTimeout(timeout)
                    resolve(diagnostics)
                }
            })
        })
    }

    function handleDiagnosticEvent(message: TsServerMessage): void {
        if (message.event !== "syntaxDiag" && message.event !== "semanticDiag") {
            if (message.event === "requestCompleted") {
                completeDiagnosticsRequest(message)
            }

            return
        }

        const body = message.body as {
            file : string,
            diagnostics : TsServerDiagnostic[]
        } | undefined

        if (body === undefined) {
            return
        }

        for (const pending of pendingDiagnostics.values()) {
            if (!pending.files.has(body.file)) {
                continue
            }

            const existing = pending.collected.get(body.file) ?? []

            pending.collected.set(body.file, existing.concat(body.diagnostics))
        }
    }

    function completeDiagnosticsRequest(message: TsServerMessage): void {
        const body = message.body as { request_seq? : number } | undefined
        const seq  = body?.request_seq

        if (seq === undefined) {
            return
        }

        const pending = pendingDiagnostics.get(seq)

        if (pending === undefined) {
            return
        }

        pendingDiagnostics.delete(seq)

        const diagnostics = [ ...pending.collected.values() ].flat()

        pending.resolve(diagnostics)
    }

    async function sendRequest(command: string, args: unknown): Promise<TsServerResponse> {
        const seq = ++sequence

        server.send({
            arguments : args,
            command,
            seq,
            type      : "request"
        })

        return new Promise<TsServerResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingResponses.delete(seq)
                reject(new Error(`Timed out waiting for tsserver response to ${command}.`))
            }, 10_000)

            pendingResponses.set(seq, (response) => {
                clearTimeout(timeout)
                resolve(response)
            })
        })
    }
}

export function replaceSubstring(
    source: string,
    search: string,
    replacement: string
): { nextSource: string, start: number, end: number } {
    const start = source.indexOf(search)

    if (start < 0) {
        throw new Error(`Cannot find substring: ${search}`)
    }

    const end = start + search.length

    return {
        end,
        nextSource : `${source.slice(0, start)}${replacement}${source.slice(end)}`,
        start
    }
}

export function textRangeFromIndices(source: string, start: number, end: number): {
    line : number,
    offset : number,
    endLine : number,
    endOffset : number
} {
    const startPosition = positionToLineOffset(source, start)
    const endPosition   = positionToLineOffset(source, end)

    return {
        line      : startPosition.line,
        offset    : startPosition.offset,
        endLine   : endPosition.line,
        endOffset : endPosition.offset
    }
}

export async function runTypeScriptServerRequest(
    fixtureDirectory: string,
    sourceFile: string,
    text: string,
    command: string,
    args: unknown,
    logFile = path.join(fixtureDirectory, "tsserver.log")
): Promise<TsServerResponse> {
    const tsserverFile = path.join(fixtureDirectory, "node_modules", "typescript", "lib", "tsserver.js")
    const server = fork(tsserverFile, [
        "--logVerbosity",
        "verbose",
        "--logFile",
        logFile,
        "--allowLocalPluginLoads",
        "--useNodeIpc"
    ], {
        cwd    : fixtureDirectory,
        silent : true
    })

    const pendingResponses = new Map<number, (response: TsServerResponse) => void>()
    let sequence           = 0

    server.on("message", (message: TsServerResponse) => {
        if (message.type !== "response" || message.request_seq === undefined) {
            return
        }

        pendingResponses.get(message.request_seq)?.(message)
        pendingResponses.delete(message.request_seq)
    })

    server.stdout?.on("data", () => {})

    await sendRequest("open", {
        file            : sourceFile,
        fileContent     : text,
        projectRootPath : fixtureDirectory,
        scriptKindName  : "TS"
    })
    const response = await sendRequest(command, args)

    server.send({
        arguments : {},
        command   : "exit",
        seq       : ++sequence,
        type      : "request"
    })

    await waitForExit(server)

    return response

    async function sendRequest(command: string, args: unknown): Promise<TsServerResponse> {
        const seq = ++sequence

        server.send({
            arguments : args,
            command,
            seq,
            type      : "request"
        })

        return new Promise<TsServerResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingResponses.delete(seq)
                reject(new Error(`Timed out waiting for tsserver response to ${command}.`))
            }, 10_000)

            pendingResponses.set(seq, (response) => {
                clearTimeout(timeout)
                resolve(response)
            })
        })
    }
}

export function positionToLineOffset(text: string, position: number): { line: number, offset: number } {
    const before = text.slice(0, position)
    const lines  = before.split("\n")

    return {
        line   : lines.length,
        offset : lines.at(-1)!.length + 1
    }
}

async function waitForExit(server: ReturnType<typeof fork>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            server.kill()
            reject(new Error("Timed out waiting for tsserver to exit."))
        }, 10_000)

        server.once("exit", () => {
            clearTimeout(timeout)
            resolve()
        })
        server.once("error", (error) => {
            clearTimeout(timeout)
            reject(error)
        })
    })
}
