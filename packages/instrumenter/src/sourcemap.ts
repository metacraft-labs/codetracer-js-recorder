/**
 * Source map utilities for the instrumenter.
 *
 * Handles detection, loading, and querying of input source maps,
 * and composing (chaining) with the instrumentation source map.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  TraceMap,
  originalPositionFor,
  decodedMappings,
  encodedMappings,
  GREATEST_LOWER_BOUND,
} from "@jridgewell/trace-mapping";
import type {
  DecodedSourceMap,
  EncodedSourceMap,
  SourceMapSegment,
} from "@jridgewell/trace-mapping";

// Re-export TraceMap for use in instrument.ts
export { TraceMap };

/**
 * Get encoded mappings string from a TraceMap.
 */
export function encodedMappingsOf(map: TraceMap): string {
  return encodedMappings(map);
}

export interface OriginalLocation {
  source: string;
  line: number;
  col: number;
}

/**
 * Detect and load a source map for a given source file.
 *
 * Detection order:
 * 1. If `explicitSourceMap` is provided, use it directly
 * 2. Check for inline source map (data: URL in sourceMappingURL comment)
 * 3. Check for external source map (.map file referenced by sourceMappingURL comment)
 *
 * Returns a TraceMap instance if a source map is found, or null otherwise.
 */
export function detectAndLoadSourceMap(
  sourceCode: string,
  filename: string,
  explicitSourceMap?: string | object,
): TraceMap | null {
  // 1. Explicit source map provided
  if (explicitSourceMap) {
    try {
      const raw =
        typeof explicitSourceMap === "string"
          ? explicitSourceMap
          : JSON.stringify(explicitSourceMap);
      return new TraceMap(raw, filename);
    } catch {
      // Invalid source map; fall back to detection
    }
  }

  // 2. Check for sourceMappingURL comment
  const sourceMappingURLMatch = sourceCode.match(
    /\/\/[#@]\s*sourceMappingURL=(.+?)(?:\s*)$/m,
  );
  if (!sourceMappingURLMatch) {
    return null;
  }

  const url = sourceMappingURLMatch[1].trim();

  // 2a. Inline source map (data: URL)
  if (url.startsWith("data:")) {
    return loadInlineSourceMap(url, filename);
  }

  // 2b. External source map file
  return loadExternalSourceMap(url, filename);
}

/**
 * Load an inline source map from a data: URL.
 */
function loadInlineSourceMap(
  dataUrl: string,
  filename: string,
): TraceMap | null {
  try {
    // Expected format: data:application/json;base64,<base64-encoded-json>
    // or: data:application/json;charset=utf-8;base64,<base64-encoded-json>
    const base64Match = dataUrl.match(
      /^data:application\/json[^,]*;base64,(.+)$/,
    );
    if (base64Match) {
      const decoded = Buffer.from(base64Match[1], "base64").toString("utf-8");
      return new TraceMap(decoded, filename);
    }

    // Also support non-base64 data URLs (URL-encoded)
    const plainMatch = dataUrl.match(/^data:application\/json[^,]*,(.+)$/);
    if (plainMatch) {
      const decoded = decodeURIComponent(plainMatch[1]);
      return new TraceMap(decoded, filename);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Load an external source map from a .map file.
 */
function loadExternalSourceMap(
  mapUrl: string,
  filename: string,
): TraceMap | null {
  try {
    // Resolve the map URL relative to the source file
    const sourceDir = path.dirname(filename);
    const mapPath = path.resolve(sourceDir, mapUrl);

    if (!fs.existsSync(mapPath)) {
      return null;
    }

    const mapContent = fs.readFileSync(mapPath, "utf-8");
    return new TraceMap(mapContent, filename);
  } catch {
    return null;
  }
}

/**
 * Create a SourceMapResolver that can resolve generated-JS positions to
 * original source positions using a TraceMap.
 */
export class SourceMapResolver {
  private traceMap: TraceMap;
  /**
   * Map from resolved source paths (as returned by originalPositionFor)
   * to un-resolved source paths (as stored in the raw source map).
   */
  private resolvedToUnresolved: Map<string, string>;

  constructor(traceMap: TraceMap) {
    this.traceMap = traceMap;

    // Build a mapping from resolved to un-resolved sources.
    // TraceMap.sources contains un-resolved paths.
    // TraceMap.resolvedSources contains paths resolved relative to the map file.
    // originalPositionFor returns resolved paths.
    this.resolvedToUnresolved = new Map();
    const resolved = traceMap.resolvedSources;
    const unresolved = traceMap.sources;
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const u = unresolved[i];
      if (r != null && u != null) {
        this.resolvedToUnresolved.set(r, u);
      }
    }
  }

  /**
   * Resolve a generated-code position (1-based line, 0-based col) to
   * the original source position.
   *
   * Returns the original location or null if resolution fails.
   * The returned source path is the un-resolved (raw) source path from
   * the source map, not the path resolved relative to the map file.
   */
  resolve(genLine: number, genCol: number): OriginalLocation | null {
    const result = originalPositionFor(this.traceMap, {
      line: genLine,
      column: genCol,
    });

    if (result.source == null || result.line == null) {
      return null;
    }

    // Map back from the resolved source path to the raw source path
    const unresolvedSource =
      this.resolvedToUnresolved.get(result.source) ?? result.source;

    return {
      source: unresolvedSource,
      line: result.line,
      col: result.column ?? 0,
    };
  }

  /**
   * Get all unique original source paths referenced by this source map.
   * Returns the un-resolved (raw) source paths.
   */
  get sources(): readonly (string | null)[] {
    return this.traceMap.sources;
  }

  /**
   * Get sourcesContent from the source map, if available.
   * Returns an array parallel to `sources`, with null for entries without content.
   */
  get sourcesContent(): readonly (string | null)[] {
    return this.traceMap.sourcesContent ?? [];
  }
}

/**
 * Compose (chain) an input source map with an output source map.
 *
 * Given:
 * - inputMap: maps generated-JS -> original source
 * - outputMap: maps instrumented-JS -> generated-JS
 *
 * Returns a composed map: instrumented-JS -> original source
 *
 * This is implemented by taking each mapping in the output map,
 * looking up its generated-JS position in the input map,
 * and replacing it with the original source position.
 */
export function composeSourceMaps(
  inputMapJson: string | object,
  outputMapJson: string,
): string {
  const inputMap = new TraceMap(
    typeof inputMapJson === "string"
      ? inputMapJson
      : JSON.stringify(inputMapJson),
  );
  const outputMap = new TraceMap(outputMapJson);

  // We'll build the composed map using @jridgewell/gen-mapping
  // Since we depend on it transitively, import dynamically
  // Actually, let's do it manually to avoid extra deps issues.
  // We'll modify the decoded output map segments in place.

  const outputDecoded = decodedMappings(outputMap);

  // A segment is a tuple: [genCol] or [genCol, sourceIdx, origLine, origCol] or with nameIdx
  type Segment =
    | [number]
    | [number, number, number, number]
    | [number, number, number, number, number];
  const composedMappings: Segment[][] = [];

  // Build composed sources list from the input map
  const inputSources = inputMap.sources;
  const inputSourcesContent = inputMap.sourcesContent ?? [];

  // Map from composed source index to source name
  const composedSources: string[] = [];
  const composedSourcesContent: (string | null)[] = [];
  const sourceIndexMap = new Map<string, number>();

  function getSourceIndex(source: string): number {
    let idx = sourceIndexMap.get(source);
    if (idx === undefined) {
      idx = composedSources.length;
      composedSources.push(source);
      // Try to find the content from the input map
      const inputIdx = inputSources.indexOf(source);
      composedSourcesContent.push(
        inputIdx >= 0 ? (inputSourcesContent[inputIdx] ?? null) : null,
      );
      sourceIndexMap.set(source, idx);
    }
    return idx;
  }

  for (const line of outputDecoded) {
    const composedLine: Segment[] = [];
    for (const segment of line) {
      if (segment.length === 1) {
        // No source mapping, just column offset
        composedLine.push([segment[0]]);
        continue;
      }

      // segment: [genCol, sourceIdx, origLine, origCol, nameIdx?]
      const genCol = segment.length >= 4 ? segment[3] : 0;
      const genLine = segment.length >= 3 ? segment[2] : 0;

      // Look up this position in the input map
      // The output map's "original" positions are generated-JS positions
      // relative to the input source (which has a source map).
      // genLine is 0-based in decoded mappings, but originalPositionFor expects 1-based.
      const origPos = originalPositionFor(inputMap, {
        line: genLine + 1,
        column: genCol,
      });

      if (origPos.source != null && origPos.line != null) {
        const srcIdx = getSourceIndex(origPos.source);
        const composed: [number, number, number, number] = [
          segment[0], // generated column (in the instrumented output)
          srcIdx,
          origPos.line - 1, // back to 0-based for decoded mappings
          origPos.column ?? 0,
        ];
        composedLine.push(composed);
      } else {
        // Can't resolve through input map; keep as-is with fallback
        composedLine.push(segment as unknown as Segment);
      }
    }
    composedMappings.push(composedLine);
  }

  // Build the composed source map object
  // We need to encode the decoded mappings back to VLQ.
  // Use @jridgewell/gen-mapping for this.
  // Since we have @jridgewell/source-map as a dependency, we can use it.
  // Actually, let's just build the raw source map and use @jridgewell/source-map to encode.

  // For simplicity, use the SourceMapGenerator approach
  const {
    GenMapping,
    toEncodedMap,
    addMapping,
    setSourceContent,
  } = require("@jridgewell/gen-mapping");
  const gen = new GenMapping({ file: outputMap.file ?? undefined });

  for (let lineIdx = 0; lineIdx < composedMappings.length; lineIdx++) {
    const line = composedMappings[lineIdx];
    for (const segment of line) {
      if (segment.length === 1) {
        addMapping(gen, {
          generated: { line: lineIdx + 1, column: segment[0] },
        });
      } else {
        const source = composedSources[segment[1] as number];
        addMapping(gen, {
          generated: { line: lineIdx + 1, column: segment[0] },
          source: source,
          original: {
            line: (segment[2] as number) + 1,
            column: segment[3] as number,
          },
        });
      }
    }
  }

  // Set sources content
  for (let i = 0; i < composedSources.length; i++) {
    if (composedSourcesContent[i] != null) {
      setSourceContent(gen, composedSources[i], composedSourcesContent[i]);
    }
  }

  const encoded = toEncodedMap(gen);
  return JSON.stringify(encoded);
}

/**
 * Strip the sourceMappingURL comment from source code so it doesn't
 * interfere with the instrumented output.
 */
export function stripSourceMappingURL(code: string): string {
  return code.replace(/\/\/[#@]\s*sourceMappingURL=.+$/m, "").trimEnd();
}
