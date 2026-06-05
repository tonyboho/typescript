import { fork } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot    = path.resolve(packageDirectory, "../..")
const projectDirectory = path.join(packageDirectory, "fixtures/basic-project")
const probeDirectory   = path.join(workspaceRoot, "tools/ts-lazy-property-tsserver-probe")
const probeRoot        = "/tmp/ts-lazy-property-tsserver-probe-root"
const fixtureFile      = path.join(projectDirectory, "src/basic.ts")
const tsserverFile     = path.join(projectDirectory, "node_modules/typescript/lib/tsserver.js")
const logFile          = "/tmp/ts-lazy-property-tsserver-probe.log"
const sourceText       = readFileSync(fixtureFile, "utf8")

if (!existsSync(tsserverFile)) {
    throw new Error(`Cannot find fixture tsserver: ${tsserverFile}`)
}

prepareProbeRoot()

const server = fork(tsserverFile, [
    "--logVerbosity",
    "verbose",
    "--logFile",
    logFile,
    "--globalPlugins",
    "ts-lazy-property-tsserver-probe",
    "--pluginProbeLocations",
    probeRoot,
    "--allowLocalPluginLoads",
    "--useNodeIpc"
], {
    cwd   : workspaceRoot,
    silent : true
})

server.stdout?.on("data", () => {})

server.once("spawn", () => {
    setTimeout(() => {
        sendRequest("open", {
            file            : fixtureFile,
            fileContent     : sourceText,
            projectRootPath : projectDirectory,
            scriptKindName  : "TS"
        })
    }, 200)

    setTimeout(() => {
        sendRequest("quickinfo", {
            file   : fixtureFile,
            line   : 14,
            offset : 22
        })
    }, 1000)

    setTimeout(() => {
        sendRequest("exit", {})
    }, 3000)
})

server.on("error", (error) => {
    console.error(error)
})

server.stdout?.on("data", (data) => {
    const text = data.toString("utf8")

    if (text.includes("Error")) {
        process.stderr.write(text)
    }
})

server.on("exit", () => {
    const logText = existsSync(logFile) ? readFileSync(logFile, "utf8") : ""
    const lines   = logText
        .split("\n")
        .filter((line) => line.includes("[ts-lazy-property-probe]"))

    console.log(`tsserver log: ${logFile}`)

    if (lines.length === 0) {
        console.log("No probe lines found. Check whether tsserver loaded local plugins.")
        return
    }

    console.log(lines.join("\n"))
})

function sendRequest(command, args) {
    const body = JSON.stringify({
        seq  : nextSequence(),
        type : "request",
        command,
        arguments : args
    })

    server.send(JSON.parse(body))
}

function nextSequence() {
    nextSequence.value = (nextSequence.value ?? 0) + 1

    return nextSequence.value
}

function prepareProbeRoot() {
    const nodeModulesDirectory = path.join(probeRoot, "node_modules")
    const packageLink          = path.join(nodeModulesDirectory, "ts-lazy-property-tsserver-probe")

    rmSync(probeRoot, {
        force     : true,
        recursive : true
    })

    mkdirSync(nodeModulesDirectory, {
        recursive : true
    })

    symlinkSync(probeDirectory, packageLink, "dir")
}
