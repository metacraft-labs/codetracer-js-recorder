/**
 * Parse trace.json events from the serde externally-tagged format produced by
 * the Rust native addon into the flat format expected by tests.
 *
 * The Rust addon serializes events using serde's default externally-tagged enum
 * representation (e.g. `{ "Step": { path_id: 0, line: 4 } }`), with snake_case
 * field names and numeric id references (variable_id, type_id). The tests expect
 * a friendlier flat format (e.g. `{ type: "Step", pathIndex: 0, line: 4 }`) with
 * resolved names and inline values.
 *
 * This module bridges the two representations so tests can validate trace content
 * without being coupled to the internal serialization details.
 */

// ── TypeKind discriminant → string mapping ──────────────────────────
// Must match the `TypeKind` repr(u8) values in crates/recorder_native/src/lib.rs.
const TYPE_KIND_MAP: Record<number, string> = {
  0: "Seq",
  6: "Struct",
  7: "Int",
  8: "Float",
  9: "String",
  11: "Bool",
  15: "Raw",
  22: "FunctionKind",
  27: "None",
};

// ── Value record → flat value ───────────────────────────────────────

interface FlatValue {
  value: unknown;
  typeKind: string;
}

interface FlatStructValue {
  value: { fields: Array<{ name: string; value: FlatValue }> };
  typeKind: "Struct";
}

/**
 * Convert a Rust ValueRecord (internally tagged with `kind`) into the flat
 * `{ value, typeKind }` format expected by tests.
 *
 * The `fieldNamesForStruct` array (from TypeSpecificInfo::Struct.fields) is
 * used to restore field names for Struct values. When unavailable, fields are
 * given synthetic names like "_field0".
 */
function flattenValueRecord(
  record: Record<string, unknown>,
  typeRegistry: Array<{ kindNum: number; fieldNames?: string[] }>,
): FlatValue {
  const kind = record.kind as string;

  switch (kind) {
    case "Int":
      return { value: record.i as number, typeKind: "Int" };
    case "Float": {
      const f = record.f as string;
      return { value: parseFloat(f), typeKind: "Float" };
    }
    case "Bool":
      return { value: record.b as boolean, typeKind: "Bool" };
    case "String":
      return { value: record.text as string, typeKind: "String" };
    case "Raw": {
      // The Rust side encodes FunctionKind values as Raw with the function
      // name as the string. Use the type_id to recover the original TypeKind
      // (e.g. "FunctionKind") from the type registry.
      const typeId = record.type_id as number | undefined;
      let rawTypeKind = "Raw";
      if (typeId !== undefined && typeRegistry[typeId]) {
        const registeredKind = TYPE_KIND_MAP[typeRegistry[typeId].kindNum];
        if (registeredKind) {
          rawTypeKind = registeredKind;
        }
      }
      return { value: record.r as string, typeKind: rawTypeKind };
    }
    case "None":
      return { value: null, typeKind: "None" };
    case "Sequence": {
      const elements = (record.elements as Record<string, unknown>[]) || [];
      const flatElements = elements.map((el) =>
        flattenValueRecord(el, typeRegistry),
      );
      return { value: flatElements, typeKind: "Seq" };
    }
    case "Struct": {
      const fieldValues =
        (record.field_values as Record<string, unknown>[]) || [];
      // Field names are stored directly on the Struct value record
      const fieldNamesArr = (record.field_names as string[]) || [];
      // Also check the type registry as a fallback
      const typeId = record.type_id as number | undefined;
      let registryFieldNames: string[] | undefined;
      if (typeId !== undefined && typeRegistry[typeId]?.fieldNames) {
        registryFieldNames = typeRegistry[typeId].fieldNames;
      }
      const fields = fieldValues.map((fv, i) => ({
        name: fieldNamesArr[i] ?? registryFieldNames?.[i] ?? `_field${i}`,
        value: flattenValueRecord(fv, typeRegistry),
      }));
      return { value: { fields }, typeKind: "Struct" } as FlatStructValue;
    }
    default:
      return { value: null, typeKind: kind };
  }
}

// ── Flat arg ────────────────────────────────────────────────────────

interface FlatArg {
  name: string;
  value: unknown;
  typeKind: string;
}

/**
 * Convert a FullValueRecord `{ variable_id, value }` into the flat
 * `{ name, value, typeKind }` format.
 *
 * For non-compound types (Int, String, Bool, etc.) the `value` field is the
 * raw JS value. For compound types (Struct, Seq) the `value` field is the
 * nested structure with `fields` or array elements.
 */
function flattenArg(
  arg: Record<string, unknown>,
  variableNames: string[],
  typeRegistry: Array<{ kindNum: number; fieldNames?: string[] }>,
): FlatArg {
  const varId = arg.variable_id as number;
  const name = variableNames[varId] ?? `_param${varId}`;
  const flat = flattenValueRecord(
    arg.value as Record<string, unknown>,
    typeRegistry,
  );
  return { name, value: flat.value, typeKind: flat.typeKind };
}

// ── Main parse function ─────────────────────────────────────────────

export interface FlatTraceEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Parse raw trace.json events (serde externally-tagged format) into a flat
 * array of `{ type, ...fields }` objects that tests can filter/assert on.
 *
 * Example transformations:
 *   { "Path": "src/main.js" }           → { type: "Path", path: "src/main.js" }
 *   { "Step": { path_id: 0, line: 4 } } → { type: "Step", pathIndex: 0, line: 4 }
 *   { "Call": { function_id: 0, ... } }  → { type: "Call", fnId: 0, args: [...] }
 */
export function parseTraceEvents(
  rawEvents: Record<string, unknown>[],
): FlatTraceEvent[] {
  // First pass: collect VariableName and Type registries
  const variableNames: string[] = [];
  const typeRegistry: Array<{ kindNum: number; fieldNames?: string[] }> = [];

  for (const raw of rawEvents) {
    const key = Object.keys(raw)[0];
    if (key === "VariableName") {
      variableNames.push(raw[key] as string);
    } else if (key === "Type") {
      const typeObj = raw[key] as Record<string, unknown>;
      const kindNum = typeObj.kind as number;
      let fieldNames: string[] | undefined;
      const specificInfo = typeObj.specific_info as Record<string, unknown>;
      if (
        specificInfo?.kind === "Struct" &&
        Array.isArray(specificInfo.fields)
      ) {
        fieldNames = specificInfo.fields.map(
          (f: Record<string, unknown>) => f.name as string,
        );
      }
      typeRegistry.push({ kindNum, fieldNames });
    }
  }

  // Second pass: transform each event into flat format
  const result: FlatTraceEvent[] = [];

  for (const raw of rawEvents) {
    const key = Object.keys(raw)[0];
    const payload = raw[key];

    switch (key) {
      case "Path":
        result.push({ type: "Path", path: payload as string });
        break;

      case "Type": {
        const typeObj = payload as Record<string, unknown>;
        const kindNum = typeObj.kind as number;
        result.push({
          type: "Type",
          kind: TYPE_KIND_MAP[kindNum] ?? "Unknown",
          langType: typeObj.lang_type,
        });
        break;
      }

      case "VariableName":
        result.push({ type: "VariableName", name: payload as string });
        break;

      case "Function": {
        const funcObj = payload as Record<string, unknown>;
        result.push({
          type: "Function",
          pathId: funcObj.path_id,
          line: funcObj.line,
          name: funcObj.name,
        });
        break;
      }

      case "Step": {
        const stepObj = payload as Record<string, unknown>;
        result.push({
          type: "Step",
          pathIndex: stepObj.path_id,
          line: stepObj.line,
        });
        break;
      }

      case "Call": {
        const callObj = payload as Record<string, unknown>;
        const rawArgs = (callObj.args as Record<string, unknown>[]) || [];
        const flatArgs = rawArgs.map((a) =>
          flattenArg(a, variableNames, typeRegistry),
        );
        result.push({
          type: "Call",
          fnId: callObj.function_id,
          args: flatArgs,
        });
        break;
      }

      case "Return": {
        const retObj = payload as Record<string, unknown>;
        const returnValue = retObj.return_value as Record<string, unknown>;
        const flatValue = flattenValueRecord(returnValue, typeRegistry);
        result.push({
          type: "Return",
          value: flatValue,
        });
        break;
      }

      case "Event": {
        // RecordEvent { kind: EventLogKind, metadata, content }
        // EventLogKind::Write = 0
        const eventObj = payload as Record<string, unknown>;
        const kindNum = eventObj.kind as number;
        // Currently only Write events exist
        if (kindNum === 0) {
          // Determine stdout/stderr from metadata if available,
          // otherwise default to "stdout"
          const metadata = (eventObj.metadata as string) || "";
          const writeKind = metadata || "stdout";
          result.push({
            type: "Write",
            kind: writeKind,
            content: eventObj.content as string,
          });
        }
        break;
      }

      case "Value": {
        const valObj = payload as Record<string, unknown>;
        const flatValue = flattenValueRecord(
          valObj.value as Record<string, unknown>,
          typeRegistry,
        );
        result.push({
          type: "Value",
          variableId: valObj.variable_id,
          value: flatValue,
        });
        break;
      }

      case "ThreadStart":
        result.push({ type: "ThreadStart", threadId: payload as number });
        break;

      case "ThreadSwitch":
        result.push({ type: "ThreadSwitch", threadId: payload as number });
        break;

      case "ThreadExit":
        result.push({ type: "ThreadExit", threadId: payload as number });
        break;

      default:
        result.push({
          type: key,
          ...(typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : { value: payload }),
        });
        break;
    }
  }

  return result;
}

/**
 * Read and parse a trace.json file, returning normalized flat events.
 *
 * Convenience wrapper that combines fs.readFileSync + JSON.parse + parseTraceEvents.
 */
export function readTraceEvents(traceJsonPath: string): FlatTraceEvent[] {
  const fs = require("node:fs");
  const rawEvents = JSON.parse(fs.readFileSync(traceJsonPath, "utf-8"));
  return parseTraceEvents(rawEvents);
}
