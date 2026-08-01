/**
 * The vocabulary `CONTEXT.md` defines, as types.
 *
 * Types and total functions over them only: no I/O, no state, and no imports from any other `src/`
 * directory, since every seam depends on this and none may depend on another.
 */
export { type EntryId, EntryIdSchema, type NativeId, NativeIdSchema } from "./ids.js";
export { type Origin, OriginSchema } from "./origin.js";
export { PLATFORMS, type Platform } from "./platform.js";
export { SCOPE_KEY_VERSION, type Scope, scopeKey } from "./scope.js";
