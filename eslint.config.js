import base from "./eslint.config.base.js"
import tsMixinClass from "./packages/ts-mixin-class/eslint.config.js"
import tsLazyProperty from "./packages/ts-lazy-property/eslint.config.js"
import tsSerializable from "./packages/ts-serializable/eslint.config.js"

// Whole-repository config: every package (each brings its own paths) plus the repo-level
// scripts, all sharing the base settings.
export default [
    {
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/tests/fixture-suite/**",
            "**/tests/declaration-fixture-suite/**",
            "**/bench/fixtures/generated/**"
        ]
    },
    tsMixinClass,
    tsLazyProperty,
    tsSerializable,
    {
        ...base,
        files: [ "scripts/**/*.ts" ]
    }
]
