/**
 * SCIP protobuf schema loader.
 *
 * The wire-level streaming decoder (P0.1) parses the top-level `Index` message
 * by hand so it never holds the whole file in memory. It still needs the
 * generated message types to decode each individual length-delimited
 * `Document` / `SymbolInformation` submessage — that is what this module
 * provides, via `protobufjs` runtime reflection (no code generation).
 *
 * The `.proto` is vendored at `scip.proto` (see its header for the upstream
 * pin) and copied next to the compiled output by the `copy-assets` build step,
 * so `__dirname` resolves it in both `src/` and `dist/`.
 */

import * as path from 'path';
import * as protobuf from 'protobufjs';

/** The SCIP message types VBGraph decodes. */
export interface ScipProtoTypes {
  Index: protobuf.Type;
  Metadata: protobuf.Type;
  Document: protobuf.Type;
  SymbolInformation: protobuf.Type;
  Occurrence: protobuf.Type;
}

const PROTO_FILENAME = 'scip.proto';

/** Loaded once per process; `protobuf.load` is async so we cache the promise. */
let cachedTypes: Promise<ScipProtoTypes> | null = null;

/** Absolute path to the vendored `scip.proto`, resolved relative to this file. */
export function scipProtoPath(): string {
  return path.join(__dirname, PROTO_FILENAME);
}

/**
 * Load and cache the SCIP message types. Safe to call concurrently — every
 * caller awaits the same underlying `protobuf.load` promise.
 */
export async function loadScipProtoTypes(): Promise<ScipProtoTypes> {
  if (cachedTypes === null) {
    cachedTypes = protobuf.load(scipProtoPath()).then((root) => ({
      Index: root.lookupType('scip.Index'),
      Metadata: root.lookupType('scip.Metadata'),
      Document: root.lookupType('scip.Document'),
      SymbolInformation: root.lookupType('scip.SymbolInformation'),
      Occurrence: root.lookupType('scip.Occurrence'),
    }));
    // Drop the cache if the load rejects, so a transient failure can be retried.
    cachedTypes.catch(() => {
      cachedTypes = null;
    });
  }
  return cachedTypes;
}

/** Reset the per-process type cache. Intended for tests. */
export function clearScipProtoTypeCache(): void {
  cachedTypes = null;
}
