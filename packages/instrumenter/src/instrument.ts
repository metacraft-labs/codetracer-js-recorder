import { parseSync, printSync } from "@swc/core";
import type { ParserConfig } from "@swc/types";
import type { InstrumentOptions, InstrumentResult } from "./index.js";
import { ManifestBuilder } from "./manifest.js";
import { LineColMapper, transformModule } from "./visitor.js";

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

  // Parse the source code into an SWC AST
  const parserConfig = getParserConfig(filename);
  const module = parseSync(code, {
    ...parserConfig,
    target: "es2022",
    comments: false,
  });

  // Build the line/col mapper for this source
  const mapper = new LineColMapper(code);

  // Create manifest builder
  const manifest = new ManifestBuilder();
  const pathIndex = manifest.addPath(filename);

  // Transform the AST
  if (module.type === "Module") {
    transformModule(module, { manifest, pathIndex, mapper });
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

  return {
    code: output.code,
    map: output.map,
    manifestSlice: manifest.build(),
  };
}
