import { parseSync, printSync } from "@swc/core";
import type { ParserConfig } from "@swc/types";
import type { InstrumentOptions, InstrumentResult } from "./index.js";
import { ManifestBuilder } from "./manifest.js";
import { LineColMapper, transformModule } from "./visitor.js";
import type { TransformContext } from "./visitor.js";
import {
  detectAndLoadSourceMap,
  SourceMapResolver,
  composeSourceMaps,
  stripSourceMappingURL,
  encodedMappingsOf,
} from "./sourcemap.js";

/**
 * Compute the SWC global base offset for this source code.
 *
 * SWC uses a global byte offset counter across parseSync calls.
 * When `comments: false`, module.span.start points to the first
 * non-comment token, not byte 0 of the source. We find where
 * that first token is in the source to compute the base offset
 * for byte 0.
 *
 * @param source The source code string
 * @param moduleSpanStart The module.span.start value from SWC
 * @returns The SWC offset value that corresponds to byte 0 of the source
 */
function computeSwcBaseOffset(source: string, moduleSpanStart: number): number {
  // Skip leading whitespace and line comments to find where SWC's
  // module.span.start points to in the source.
  let pos = 0;
  const len = source.length;
  while (pos < len) {
    // Skip whitespace
    if (
      source[pos] === " " ||
      source[pos] === "\t" ||
      source[pos] === "\n" ||
      source[pos] === "\r"
    ) {
      pos++;
      continue;
    }
    // Skip line comments
    if (source[pos] === "/" && pos + 1 < len && source[pos + 1] === "/") {
      pos += 2;
      while (pos < len && source[pos] !== "\n") pos++;
      continue;
    }
    // Skip block comments
    if (source[pos] === "/" && pos + 1 < len && source[pos + 1] === "*") {
      pos += 2;
      while (pos < len - 1 && !(source[pos] === "*" && source[pos + 1] === "/"))
        pos++;
      if (pos < len - 1) pos += 2;
      continue;
    }
    // Found first non-comment, non-whitespace character
    break;
  }

  // pos is now the 0-based position of the first non-comment content.
  // module.span.start is the SWC offset for this position.
  // So: base = module.span.start - pos
  return moduleSpanStart - pos;
}

/**
 * Determine the SWC parser config based on the filename extension.
 */
function getParserConfig(filename: string): ParserConfig {
  if (filename.endsWith(".ts") || filename.endsWith(".tsx")) {
    return {
      syntax: "typescript",
      tsx: filename.endsWith(".tsx"),
    };
  }
  return {
    syntax: "ecmascript",
    jsx: filename.endsWith(".jsx"),
  };
}

/**
 * Instrument a JavaScript/TypeScript source file by inserting
 * __ct.step/enter/ret calls via SWC transformation.
 */
export function instrument(
  code: string,
  options: InstrumentOptions,
): InstrumentResult {
  const { filename } = options;

  // Detect and load input source map (if any)
  const inputTraceMap = detectAndLoadSourceMap(
    code,
    filename,
    options.inputSourceMap,
  );
  const resolver = inputTraceMap ? new SourceMapResolver(inputTraceMap) : null;

  // Strip sourceMappingURL comment from source before parsing
  // (SWC doesn't need it and it would appear in the output)
  const cleanCode = inputTraceMap ? stripSourceMappingURL(code) : code;

  // Parse the source code into an SWC AST
  const parserConfig = getParserConfig(filename);
  const module = parseSync(cleanCode, {
    ...parserConfig,
    target: "es2022",
    comments: false,
  });

  // Build the line/col mapper for the (possibly cleaned) source.
  // SWC uses a global span offset counter across parseSync calls,
  // so we need to compute the base offset for this parse.
  //
  // The base offset is the SWC span value for byte 0 of the source.
  // We compute it from module.span.start and the position of the
  // first non-comment content in the source, since comments: false
  // causes module.span.start to skip leading comments.
  const baseOffset = computeSwcBaseOffset(cleanCode, module.span.start);
  const mapper = new LineColMapper(cleanCode, baseOffset);

  // Create manifest builder
  const manifest = new ManifestBuilder();
  const pathIndex = manifest.addPath(filename);

  // If we have a source map resolver, register original source paths
  // and store sourcesContent
  if (resolver) {
    const sources = resolver.sources;
    const sourcesContent = resolver.sourcesContent;
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      if (src != null) {
        manifest.addPath(src);
        if (sourcesContent[i] != null) {
          manifest.setSourceContent(src, sourcesContent[i]!);
        }
      }
    }
  }

  // Build the resolveLocation function for the context
  const resolveLocation = (
    line: number,
    col: number,
  ): { pathIndex: number; line: number; col: number } => {
    if (resolver) {
      const orig = resolver.resolve(line, col);
      if (orig) {
        // Look up or register the original source path
        const origPathIndex = manifest.addPath(orig.source);
        return {
          pathIndex: origPathIndex,
          line: orig.line,
          col: orig.col,
        };
      }
    }
    // Fall back to generated-JS path and location
    return { pathIndex, line, col };
  };

  // Build transform context
  const ctx: TransformContext = {
    manifest,
    pathIndex,
    mapper,
    sourceMapResolver: resolver ?? undefined,
    resolveLocation,
  };

  // Transform the AST
  if (module.type === "Module") {
    transformModule(module, ctx);
  } else {
    // Script mode — wrap body similar to module
    // For now, handle as module (SWC parseSync returns Module by default)
    throw new Error("Script mode not yet supported; use module mode.");
  }

  // Generate output code
  const output = printSync(module, {
    sourceMaps: true,
    filename,
  });

  // Chain source maps if we had an input source map
  let finalMap = output.map;
  if (inputTraceMap && finalMap) {
    try {
      // The input map's raw JSON is needed for composition.
      // TraceMap doesn't expose the original JSON, so we reconstruct it
      // by passing the inputTraceMap's data through a re-serialization.
      // Build a raw source map object from the TraceMap
      const rawInputMap: Record<string, unknown> = {
        version: 3,
        sources: Array.from(inputTraceMap.sources),
        names: Array.from(inputTraceMap.names),
        mappings: encodedMappingsOf(inputTraceMap),
      };
      if (inputTraceMap.file) rawInputMap.file = inputTraceMap.file;
      if (inputTraceMap.sourcesContent) {
        rawInputMap.sourcesContent = Array.from(inputTraceMap.sourcesContent);
      }
      if (inputTraceMap.sourceRoot) {
        rawInputMap.sourceRoot = inputTraceMap.sourceRoot;
      }

      finalMap = composeSourceMaps(rawInputMap, finalMap);
    } catch {
      // If composition fails, fall back to just the output map
    }
  }

  return {
    code: output.code,
    map: finalMap,
    manifestSlice: manifest.build(),
  };
}
