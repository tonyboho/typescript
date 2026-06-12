import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, packageRoot, trimIndent } from "./util.js"
import { positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
import type { TsServerResponse } from "./tsserver-util.js"

type TextPosition = {
    line : number,
    offset : number
}

type TextSpan = {
    start : TextPosition,
    end : TextPosition
}

type DefinitionInfo = TextSpan & {
    file : string
}

type DefinitionAndBoundSpanBody = {
    definitions? : DefinitionInfo[]
}

type QuickInfoBody = TextSpan & {
    displayString? : string
}

type RenameResponseBody = {
    info? : {
        canRename? : boolean,
        displayName? : string
    },
    locs? : RenameFileLocation[]
}

type SemanticDiagnostic = {
    code? : number,
    text? : string,
    message? : string,
    start? : TextPosition,
    end? : TextPosition
}

type RenameFileLocation = {
    file : string,
    locs : TextSpan[]
}

const requiredBaseDiagnosticParts = [
    "Mixin required base mismatch",
    "Mixin RequiredMixin can only be applied to RequiredBase",
    "BadRequiredConsumer extends UnrelatedRequiredConsumerBase",
    "extends means a required consumer base"
]

const linearizationDiagnosticParts = [
    "Cannot linearize mixin classes with the C3 algorithm",
    "Conflicting order requirements",
    "LinearizationA -> LinearizationB",
    "LinearizationB -> LinearizationA"
]

const invalidMixinDiagnosticParts = [
    "Invalid mixin class declaration",
    "Mixin class ConstructorMixin cannot declare a constructor",
    "Mixin class PrivateMixin member value cannot be private or protected",
    "Mixin class MissingPropertyTypeMixin property value must have an explicit type annotation",
    "Mixin class MissingMethodReturnTypeMixin method method must have an explicit return type annotation",
    "Mixin class MissingParameterTypeMixin method parameter value must have an explicit type annotation",
    "Mixin class MissingAccessorTypeMixin accessor value must have an explicit type annotation"
]

const anonymousConsumerDiagnosticParts = [
    "Invalid mixin consumer declaration",
    "A mixin consumer class must be named",
    "export default class Consumer"
]

const unsupportedBaseDiagnosticParts = [
    "Unsupported mixin consumer base expression",
    "Consumer extends makeBase()",
    "Only named base classes such as Base or ns.Base are supported for now",
    "assign the expression to a named class or const"
]

const sourceText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class SourceMixin {
        mixinProperty: string = "mixin"

        mixinMethod(): string {
            return this.mixinProperty
        }

        callOwnMethod(): string {
            return this.mixinMethod()
        }
    }

    @mixin()
    class ChildMixin implements SourceMixin {
        childMethod(): string {
            return super.mixinProperty
        }

        childCallMethod(): string {
            return super.mixinMethod()
        }
    }

    class PlainBase {
        baseProperty: number = 42

        baseMethod(): number {
            return this.baseProperty
        }
    }

    class PlainConsumer extends PlainBase {
    }

    class MixinConsumer implements SourceMixin {
        readSuperProperty(): string {
            return super.mixinProperty
        }

        callSuperMethod(): string {
            return super.mixinMethod()
        }
    }

    const plain = new PlainConsumer()
    const mixed = new MixinConsumer()

    plain.baseProperty
    plain.baseMethod()
    mixed.mixinProperty
    mixed.mixinMethod()
`)

const importedMixinText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class ImportedMixin {
        importedProperty: string = "imported"

        importedMethod(): string {
            return this.importedProperty
        }
    }
`)

const importedConsumerText = trimIndent(`
    import { ImportedMixin } from "./mixins.js"

    class ImportedConsumer implements ImportedMixin {
        readImportedSuperProperty(): string {
            return super.importedProperty
        }

        callImportedSuperMethod(): string {
            return super.importedMethod()
        }
    }
`)

const fixtureLikeMixinsText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class SourceClass1<A1> {
        value1: string = "value1"

        method1(): string {
            return this.value1
        }
    }

    @mixin()
    export class SourceClass2<A2> {
        value2: string = "value2"

        method2(): string {
            return this.value2
        }
    }
`)

const diagnosticMixinsText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    export class RequiredBase {
        requiredMethod(): string {
            return "required"
        }
    }

    @mixin()
    export class RequiredMixin extends RequiredBase {
        mixinMethod(): string {
            return super.requiredMethod()
        }
    }
`)

const importedRequiredBaseDiagnosticText = trimIndent(`
    import { RequiredMixin } from "./mixins.js"

    class UnrelatedRequiredConsumerBase {
    }

    class BadRequiredConsumer extends UnrelatedRequiredConsumerBase implements RequiredMixin {
    }
`)

const fixtureLikeConsumerText = trimIndent(`
    import { SourceClass1, SourceClass2 } from "./mixins.js"

    class Base<T> {
        baseValue: T

        constructor(baseValue: T) {
            this.baseValue = baseValue
        }
    }

    class Consumer<A2> extends Base<A2> implements SourceClass1<string>, SourceClass2<A2> {
        method1(): string {
            this.value1 = "value1"
            super.value2 = "value2"

            return super.method1()
        }
    }
`)

const diagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class RequiredBase {
        requiredMethod(): string {
            return "required"
        }
    }

    class UnrelatedRequiredConsumerBase {
    }

    @mixin()
    class RequiredMixin extends RequiredBase {
        mixinMethod(): string {
            return super.requiredMethod()
        }
    }

    class BadRequiredConsumer extends UnrelatedRequiredConsumerBase implements RequiredMixin {
    }

    @mixin()
    class LinearizationA {
    }

    @mixin()
    class LinearizationB {
    }

    @mixin()
    class LinearizationX implements LinearizationA, LinearizationB {
    }

    @mixin()
    class LinearizationY implements LinearizationB, LinearizationA {
    }

    @mixin()
    class BadLinearizationMixin implements LinearizationX, LinearizationY {
    }

    class BadLinearizationConsumer implements BadLinearizationMixin {
    }
`)

const invalidMixinDiagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    abstract class AbstractMixin {
    }

    @mixin()
    class ConstructorMixin {
        constructor() {}
    }

    @mixin()
    class PrivateMixin {
        private value: string = "x"
    }

    @mixin()
    class MissingPropertyTypeMixin {
        value = "x"
    }

    @mixin()
    class MissingMethodReturnTypeMixin {
        method() {
            return "x"
        }
    }

    @mixin()
    class MissingParameterTypeMixin {
        method(value): string {
            return String(value)
        }
    }

    @mixin()
    class MissingAccessorTypeMixin {
        get value() {
            return "x"
        }
    }
`)

const anonymousConsumerDiagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class SourceMixin {
        value: string = "x"
    }

    export default class implements SourceMixin {
    }
`)

const unsupportedBaseDiagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    function makeBase(): new () => object {
        return class {
        }
    }

    @mixin()
    class SourceMixin {
        value: string = "x"
    }

    class Consumer extends makeBase() implements SourceMixin {
    }
`)

it("tsserver definition resolves plain and mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertDefinition(t, sourceFile, "baseProperty", "baseProperty: number", "Plain base property")
        await assertDefinition(t, sourceFile, "baseMethod", "baseMethod(): number", "Plain base method")
        await assertDefinition(t, sourceFile, "mixinProperty", "mixinProperty: string", "Mixin property")
        await assertDefinition(t, sourceFile, "mixinMethod", "mixinMethod(): string", "Mixin method")
        await assertDefinition(
            t,
            sourceFile,
            "mixinProperty",
            "mixinProperty: string",
            "Mixin self property",
            selfMixinPropertyArgs(sourceFile)
        )
        await assertDefinition(
            t,
            sourceFile,
            "mixinProperty",
            "mixinProperty: string",
            "Mixin super property",
            superMixinPropertyArgs(sourceFile)
        )
        await assertDefinition(
            t,
            sourceFile,
            "mixinMethod",
            "mixinMethod(): string",
            "Mixin super method",
            superMixinMethodArgs(sourceFile)
        )
        await assertDefinition(
            t,
            sourceFile,
            "mixinProperty",
            "mixinProperty: string",
            "Consumer super property",
            consumerSuperMixinPropertyArgs(sourceFile)
        )
        await assertDefinition(
            t,
            sourceFile,
            "mixinMethod",
            "mixinMethod(): string",
            "Consumer super method",
            consumerSuperMixinMethodArgs(sourceFile)
        )
    } finally {
        await dispose()
    }
})

it("tsserver definitionAndBoundSpan resolves super mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertDefinitionAndBoundSpan(
            t,
            sourceFile,
            "mixinProperty",
            "mixinProperty: string",
            "Mixin super property",
            superMixinPropertyArgs(sourceFile)
        )
        await assertDefinitionAndBoundSpan(
            t,
            sourceFile,
            "mixinMethod",
            "mixinMethod(): string",
            "Mixin super method",
            superMixinMethodArgs(sourceFile)
        )
        await assertDefinitionAndBoundSpan(
            t,
            sourceFile,
            "mixinProperty",
            "mixinProperty: string",
            "Consumer super property",
            consumerSuperMixinPropertyArgs(sourceFile)
        )
        await assertDefinitionAndBoundSpan(
            t,
            sourceFile,
            "mixinMethod",
            "mixinMethod(): string",
            "Consumer super method",
            consumerSuperMixinMethodArgs(sourceFile)
        )
    } finally {
        await dispose()
    }
})

it("tsserver quickinfo reports plain and mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertQuickInfo(t, sourceFile, "baseProperty", [ "baseProperty: number", "PlainBase.baseProperty" ])
        await assertQuickInfo(t, sourceFile, "baseMethod", [ "baseMethod(): number", "PlainBase.baseMethod" ])
        await assertQuickInfo(t, sourceFile, "mixinProperty", [ "(property)", "mixinProperty: string" ])
        await assertQuickInfo(t, sourceFile, "mixinMethod", [ "(method)", "mixinMethod(): string" ])
        await assertQuickInfo(
            t,
            sourceFile,
            "mixinProperty",
            [ "(property)", "mixinProperty: string" ],
            selfMixinPropertyArgs(sourceFile)
        )
        await assertQuickInfo(
            t,
            sourceFile,
            "mixinProperty",
            [ "(property)", "mixinProperty: string" ],
            superMixinPropertyArgs(sourceFile)
        )
        await assertQuickInfo(
            t,
            sourceFile,
            "mixinMethod",
            [ "(method)", "mixinMethod(): string" ],
            superMixinMethodArgs(sourceFile)
        )
        await assertQuickInfo(
            t,
            sourceFile,
            "mixinProperty",
            [ "(property)", "mixinProperty: string" ],
            consumerSuperMixinPropertyArgs(sourceFile)
        )
        await assertQuickInfo(
            t,
            sourceFile,
            "mixinMethod",
            [ "(method)", "mixinMethod(): string" ],
            consumerSuperMixinMethodArgs(sourceFile)
        )
    } finally {
        await dispose()
    }
})

it("tsserver resolves consumer super members from imported mixins", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : importedConsumerText
            },
            {
                fileName : "mixins.ts",
                text     : importedMixinText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const mixinFile  = requiredFixtureSourceFile(fixture.sourceFiles, "mixins.ts")

        await assertImportedDefinition(
            t,
            sourceFile,
            mixinFile,
            "importedProperty",
            "importedProperty: string",
            importedConsumerSuperPropertyArgs(sourceFile)
        )
        await assertImportedDefinition(
            t,
            sourceFile,
            mixinFile,
            "importedMethod",
            "importedMethod(): string",
            importedConsumerSuperMethodArgs(sourceFile)
        )
        await assertImportedDefinitionAndBoundSpan(
            t,
            sourceFile,
            mixinFile,
            "importedProperty",
            "importedProperty: string",
            importedConsumerSuperPropertyArgs(sourceFile)
        )
        await assertImportedDefinitionAndBoundSpan(
            t,
            sourceFile,
            mixinFile,
            "importedMethod",
            "importedMethod(): string",
            importedConsumerSuperMethodArgs(sourceFile)
        )
        await assertImportedQuickInfo(
            t,
            sourceFile,
            [ "(property)", "importedProperty: string" ],
            importedConsumerSuperPropertyArgs(sourceFile)
        )
        await assertImportedQuickInfo(
            t,
            sourceFile,
            [ "(method)", "importedMethod(): string" ],
            importedConsumerSuperMethodArgs(sourceFile)
        )
    } finally {
        await fixture.dispose()
    }
})

it("tsserver resolves fixture-like consumer super members from imported generic mixins", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : fixtureLikeConsumerText
            },
            {
                fileName : "mixins.ts",
                text     : fixtureLikeMixinsText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const mixinFile  = requiredFixtureSourceFile(fixture.sourceFiles, "mixins.ts")

        await assertFixtureLikeDefinition(
            t,
            sourceFile,
            mixinFile,
            "value2",
            "value2: string",
            fixtureLikeSuperValue2Args(sourceFile)
        )
        await assertFixtureLikeDefinition(
            t,
            sourceFile,
            mixinFile,
            "method1",
            "method1(): string",
            fixtureLikeSuperMethod1Args(sourceFile)
        )
        await assertFixtureLikeDefinitionAndBoundSpan(
            t,
            sourceFile,
            mixinFile,
            "value2",
            "value2: string",
            fixtureLikeSuperValue2Args(sourceFile)
        )
        await assertFixtureLikeDefinitionAndBoundSpan(
            t,
            sourceFile,
            mixinFile,
            "method1",
            "method1(): string",
            fixtureLikeSuperMethod1Args(sourceFile)
        )
        await assertFixtureLikeQuickInfo(
            t,
            sourceFile,
            [ "(property)", "value2: string" ],
            fixtureLikeSuperValue2Args(sourceFile)
        )
        await assertFixtureLikeQuickInfo(
            t,
            sourceFile,
            [ "(method)", "method1(): string" ],
            fixtureLikeSuperMethod1Args(sourceFile)
        )
    } finally {
        await fixture.dispose()
    }
})

it("tsserver rename updates mixin method usages from self, external and super calls", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinMethodArgs(sourceFile), description : "self mixin method call" },
            { args : usageArgs(sourceFile, "mixinMethod"), description : "external mixin method call" },
            { args : superMixinMethodArgs(sourceFile), description : "super mixin method call" }
        ]) {
            const renamedText = assertRenameAllowed(
                t,
                await request(sourceFile, "rename", scenario.args),
                sourceFile,
                "mixinMethod",
                "renamedMixinMethod"
            )

            t.true(renamedText.includes("renamedMixinMethod(): string"), `Renames declaration from ${scenario.description}`)
            t.true(renamedText.includes("this.renamedMixinMethod()"), `Renames self usage from ${scenario.description}`)
            t.true(renamedText.includes("mixed.renamedMixinMethod()"), `Renames external usage from ${scenario.description}`)
            t.true(renamedText.includes("super.renamedMixinMethod()"), `Renames super usage from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver semantic diagnostics report mixin transform type errors", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : diagnosticText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                diagnosticText,
                "semanticDiagnosticsSync",
                { file : sourceFile }
            )
        )
        const messages = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, requiredBaseDiagnosticParts)
        assertDiagnosticParts(t, messages, linearizationDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report imported required-base mixin errors", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : importedRequiredBaseDiagnosticText
            },
            {
                fileName : "mixins.ts",
                text     : diagnosticMixinsText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                importedRequiredBaseDiagnosticText,
                "semanticDiagnosticsSync",
                { file : sourceFile }
            )
        )
        const messages = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, requiredBaseDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report invalid mixin declarations with custom messages", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : invalidMixinDiagnosticText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                invalidMixinDiagnosticText,
                "semanticDiagnosticsSync",
                { file : sourceFile }
            )
        )
        const messages = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, invalidMixinDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report anonymous mixin consumers with a custom message", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : anonymousConsumerDiagnosticText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                anonymousConsumerDiagnosticText,
                "semanticDiagnosticsSync",
                { file : sourceFile }
            )
        )
        const messages = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, anonymousConsumerDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report unsupported mixin consumer base expressions with a custom message", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : unsupportedBaseDiagnosticText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                unsupportedBaseDiagnosticText,
                "semanticDiagnosticsSync",
                { file : sourceFile }
            )
        )
        const messages = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, unsupportedBaseDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report copied fixture type-errors without expect-error suppressions", async (t: Test) => {
    const typeErrorsSource = await readFile(
        path.join(packageRoot, "tests", "fixture-suite", "src", "type-errors.ts"),
        "utf8"
    )
    const typeErrorsText = removeExpectErrorLines(typeErrorsSource)
    const mixinsText = await readFile(
        path.join(packageRoot, "tests", "fixture-suite", "src", "mixins.ts"),
        "utf8"
    )
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles            : [
            {
                fileName : "type-errors.ts",
                text     : typeErrorsText
            },
            {
                fileName : "mixins.ts",
                text     : mixinsText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "type-errors.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                typeErrorsText,
                "semanticDiagnosticsSync",
                { file : sourceFile }
            )
        )
        const messages = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, requiredBaseDiagnosticParts)
        assertDiagnosticParts(t, messages, linearizationDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("fixture type-errors keeps expect-error suppressions for both IDE diagnostics", async (t: Test) => {
    const typeErrorsSource = await readFile(
        path.join(packageRoot, "tests", "fixture-suite", "src", "type-errors.ts"),
        "utf8"
    )
    const expectErrorLines = typeErrorsSource
        .split("\n")
        .filter((line) => line.includes("@ts-expect-error"))

    t.equal(expectErrorLines.length, 2, "Fixture has one suppression per expected diagnostic")
    t.true(expectErrorLines.some((line) => line.includes("RequiredMixin")), expectErrorLines.join("\n"))
    t.true(expectErrorLines.some((line) => line.includes("BadLinearizationMixin")), expectErrorLines.join("\n"))
})

async function createEditorFixture(): Promise<{
    dispose : () => Promise<void>,
    sourceFile : string
}> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : sourceText
            }
        ]
    })
    const sourceFile = fixture.sourceFiles.get("source.ts")

    if (sourceFile === undefined) {
        throw new Error("Missing fixture source file.")
    }

    return {
        dispose : fixture.dispose,
        sourceFile
    }
}

function requiredFixtureSourceFile(sourceFiles: Map<string, string>, fileName: string): string {
    const sourceFile = sourceFiles.get(fileName)

    if (sourceFile === undefined) {
        throw new Error(`Missing fixture source file: ${fileName}`)
    }

    return sourceFile
}

async function assertDefinition(
    t: Test,
    sourceFile: string,
    memberName: string,
    declarationText: string,
    description: string,
    args = usageArgs(sourceFile, memberName)
): Promise<void> {
    const definitions = assertResponseBody<DefinitionInfo[]>(
        t,
        await request(sourceFile, "definition", args)
    )

    t.true(definitions.some((definition) => {
        return definition.file === sourceFile &&
            sourceSlice(sourceText, definition) === memberName &&
            sourceText.slice(positionToIndex(sourceText, definition.start)).startsWith(declarationText)
    }), `${description} usage resolves to its source declaration`)
}

async function assertImportedDefinition(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const definitions = assertResponseBody<DefinitionInfo[]>(
        t,
        await importedRequest(sourceFile, "definition", args)
    )

    t.true(definitions.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(importedMixinText, definition) === memberName &&
            importedMixinText.slice(positionToIndex(importedMixinText, definition.start)).startsWith(declarationText)
    }), `Imported ${memberName} usage resolves to its source declaration`)
}

async function assertFixtureLikeDefinition(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const definitions = assertResponseBody<DefinitionInfo[]>(
        t,
        await requestWithSourceText(sourceFile, fixtureLikeConsumerText, "definition", args)
    )

    t.true(definitions.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(fixtureLikeMixinsText, definition) === memberName &&
            fixtureLikeMixinsText.slice(positionToIndex(fixtureLikeMixinsText, definition.start)).startsWith(declarationText)
    }), `Fixture-like ${memberName} usage resolves to its source declaration`)
}

async function assertDefinitionAndBoundSpan(
    t: Test,
    sourceFile: string,
    memberName: string,
    declarationText: string,
    description: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const body = assertResponseBody<DefinitionAndBoundSpanBody>(
        t,
        await request(sourceFile, "definitionAndBoundSpan", args)
    )

    t.true(body.definitions?.some((definition) => {
        return definition.file === sourceFile &&
            sourceSlice(sourceText, definition) === memberName &&
            sourceText.slice(positionToIndex(sourceText, definition.start)).startsWith(declarationText)
    }) === true, `${description} quick definition resolves to its source declaration`)
}

async function assertImportedDefinitionAndBoundSpan(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const body = assertResponseBody<DefinitionAndBoundSpanBody>(
        t,
        await importedRequest(sourceFile, "definitionAndBoundSpan", args)
    )

    t.true(body.definitions?.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(importedMixinText, definition) === memberName &&
            importedMixinText.slice(positionToIndex(importedMixinText, definition.start)).startsWith(declarationText)
    }) === true, `Imported ${memberName} quick definition resolves to its source declaration`)
}

async function assertFixtureLikeDefinitionAndBoundSpan(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const body = assertResponseBody<DefinitionAndBoundSpanBody>(
        t,
        await requestWithSourceText(sourceFile, fixtureLikeConsumerText, "definitionAndBoundSpan", args)
    )

    t.true(body.definitions?.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(fixtureLikeMixinsText, definition) === memberName &&
            fixtureLikeMixinsText.slice(positionToIndex(fixtureLikeMixinsText, definition.start)).startsWith(declarationText)
    }) === true, `Fixture-like ${memberName} quick definition resolves to its source declaration`)
}

async function assertQuickInfo(
    t: Test,
    sourceFile: string,
    memberName: string,
    expectedParts: string[],
    args = usageArgs(sourceFile, memberName)
): Promise<void> {
    const quickInfo = assertResponseBody<QuickInfoBody>(
        t,
        await request(sourceFile, "quickinfo", args)
    )

    t.true(
        expectedParts.every((expectedPart) => {
            return quickInfo.displayString?.includes(expectedPart) === true
        }),
        quickInfo.displayString ?? `Missing quickinfo for ${memberName}`
    )
}

async function assertImportedQuickInfo(
    t: Test,
    sourceFile: string,
    expectedParts: string[],
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const quickInfo = assertResponseBody<QuickInfoBody>(
        t,
        await importedRequest(sourceFile, "quickinfo", args)
    )

    t.true(
        expectedParts.every((expectedPart) => {
            return quickInfo.displayString?.includes(expectedPart) === true
        }),
        quickInfo.displayString ?? "Missing imported quickinfo"
    )
}

async function assertFixtureLikeQuickInfo(
    t: Test,
    sourceFile: string,
    expectedParts: string[],
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const quickInfo = assertResponseBody<QuickInfoBody>(
        t,
        await requestWithSourceText(sourceFile, fixtureLikeConsumerText, "quickinfo", args)
    )

    t.true(
        expectedParts.every((expectedPart) => {
            return quickInfo.displayString?.includes(expectedPart) === true
        }),
        quickInfo.displayString ?? "Missing fixture-like quickinfo"
    )
}

async function request(sourceFile: string, command: string, args: unknown): Promise<TsServerResponse> {
    return requestWithSourceText(sourceFile, sourceText, command, args)
}

async function importedRequest(sourceFile: string, command: string, args: unknown): Promise<TsServerResponse> {
    return requestWithSourceText(sourceFile, importedConsumerText, command, args)
}

async function requestWithSourceText(
    sourceFile: string,
    text: string,
    command: string,
    args: unknown
): Promise<TsServerResponse> {
    return runTypeScriptServerRequest(
        sourceFile.slice(0, sourceFile.lastIndexOf("/")),
        sourceFile,
        text,
        command,
        args
    )
}

function usageArgs(sourceFile: string, memberName: string): { file: string, line: number, offset: number } {
    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, memberUsagePosition(memberName))
    }
}

function selfMixinPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    const accessText = "this.mixinProperty"
    const position   = sourceText.indexOf(accessText)

    if (position < 0) {
        throw new Error("Cannot find mixin self property usage.")
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, position + "this.".length + 1)
    }
}

function superMixinPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    const accessText = "super.mixinProperty"
    const position   = sourceText.indexOf(accessText)

    if (position < 0) {
        throw new Error("Cannot find mixin super property usage.")
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, position + "super.".length + 1)
    }
}

function selfMixinMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "this.mixinMethod", "this.")
}

function superMixinMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "super.mixinMethod", "super.")
}

function consumerSuperMixinPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "super.mixinProperty", "super.", "readSuperProperty(): string")
}

function consumerSuperMixinMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "super.mixinMethod", "super.", "callSuperMethod(): string")
}

function importedConsumerSuperPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        importedConsumerText,
        sourceFile,
        "super.importedProperty",
        "super.",
        "readImportedSuperProperty(): string"
    )
}

function importedConsumerSuperMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        importedConsumerText,
        sourceFile,
        "super.importedMethod",
        "super.",
        "callImportedSuperMethod(): string"
    )
}

function fixtureLikeSuperValue2Args(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        fixtureLikeConsumerText,
        sourceFile,
        "super.value2",
        "super.",
        "method1(): string"
    )
}

function fixtureLikeSuperMethod1Args(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        fixtureLikeConsumerText,
        sourceFile,
        "super.method1",
        "super.",
        "return super.method1()"
    )
}

function accessArgs(
    sourceFile: string,
    accessText: string,
    receiver: string,
    containingText?: string
): { file: string, line: number, offset: number } {
    return sourceAccessArgs(sourceText, sourceFile, accessText, receiver, containingText)
}

function sourceAccessArgs(
    source: string,
    sourceFile: string,
    accessText: string,
    receiver: string,
    containingText?: string
): { file: string, line: number, offset: number } {
    const containingPosition = containingText === undefined ? 0 : source.indexOf(containingText)

    if (containingPosition < 0) {
        throw new Error(`Cannot find containing text: ${containingText}`)
    }

    const position = source.indexOf(accessText, containingPosition)

    if (position < 0) {
        throw new Error(`Cannot find access: ${accessText}`)
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(source, position + receiver.length + 1)
    }
}

function memberUsagePosition(memberName: string): number {
    const receivers = [ "plain", "mixed" ]

    for (const receiver of receivers) {
        const accessText = `${receiver}.${memberName}`
        const position   = sourceText.indexOf(accessText)

        if (position >= 0) {
            return position + receiver.length + 1 + 1
        }
    }

    throw new Error(`Cannot find member usage: ${memberName}`)
}

function assertResponseBody<Body>(t: Test, response: TsServerResponse): Body {
    t.true(response.success, response.message ?? `tsserver ${response.command ?? "request"} succeeds`)

    if (response.body === undefined) {
        throw new Error(`Missing tsserver response body: ${JSON.stringify(response)}`)
    }

    return response.body as Body
}

function assertDiagnosticParts(t: Test, messages: string, expectedParts: string[]): void {
    for (const expectedPart of expectedParts) {
        t.true(messages.includes(expectedPart), messages)
    }
}

function assertRenameAllowed(
    t: Test,
    response: TsServerResponse,
    sourceFile: string,
    displayName: string,
    nextName: string
): string {
    const body = assertResponseBody<RenameResponseBody>(t, response)

    t.equal(response.command, "rename", "Response belongs to the rename command")
    t.true(body.info?.canRename, JSON.stringify(response.body))
    t.equal(body.info?.displayName, displayName, "Rename info points at the source method")
    t.true(Array.isArray(body.locs) && body.locs.length > 0, "Rename response contains rename locations")

    return applyRenameLocations(sourceFile, body.locs ?? [], nextName)
}

function applyRenameLocations(
    sourceFile: string,
    fileLocations: RenameFileLocation[],
    nextName: string
): string {
    const edits = fileLocations
        .filter((fileLocation) => fileLocation.file === sourceFile)
        .flatMap((fileLocation) => fileLocation.locs)
        .map((location) => {
            return {
                start : positionToIndex(sourceText, location.start),
                end   : positionToIndex(sourceText, location.end)
            }
        })
        .sort((left, right) => right.start - left.start)

    let nextSource = sourceText

    for (const edit of edits) {
        nextSource = `${nextSource.slice(0, edit.start)}${nextName}${nextSource.slice(edit.end)}`
    }

    return nextSource
}

function sourceSlice(source: string, span: TextSpan): string {
    return source.slice(positionToIndex(source, span.start), positionToIndex(source, span.end))
}

function removeExpectErrorLines(source: string): string {
    return source
        .split("\n")
        .filter((line) => !line.includes("@ts-expect-error"))
        .join("\n")
}

function positionToIndex(source: string, position: TextPosition): number {
    const lines = source.split("\n")
    const beforeLine = lines
        .slice(0, position.line - 1)
        .reduce((sum, line) => sum + line.length + 1, 0)

    return beforeLine + position.offset - 1
}
