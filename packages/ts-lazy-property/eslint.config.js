import base from "../../eslint.config.base.js"

// Base settings + this package's own paths.
export default {
    ...base,
    files: [
        "packages/ts-lazy-property/src/**/*.{ts,tsx}",
        "packages/ts-lazy-property/tests/**/*.{ts,tsx}"
    ]
}
