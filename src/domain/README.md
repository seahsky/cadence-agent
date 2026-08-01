# domain

The vocabulary `CONTEXT.md` defines, as types. `EntryId`, `Origin`, `Scope`, `NativeId`, and the shapes the seams pass each other.

Types and total functions over them only. No I/O, no state, and no imports from any other `src/` directory, so that every seam can depend on this and none has to depend on another.

It exists because of [ADR 0007](../../docs/adr/0007-channel-abstraction.md): a channel adapter has to speak `EntryId` while being forbidden from importing `storage`, so those types can live in neither.
