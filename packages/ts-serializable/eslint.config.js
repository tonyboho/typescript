import base from "../../eslint.config.base.js"

// Base settings + this package's own paths.
export default {
    ...base,
    files: [
        "packages/ts-serializable/src/**/*.{ts,tsx}",
        "packages/ts-serializable/tests/**/*.{ts,tsx}"
    ]
}
