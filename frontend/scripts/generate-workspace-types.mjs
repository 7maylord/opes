import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const contractUrl = new URL("../../backend/openapi.workspace.json", import.meta.url);
const outputUrl = new URL("../lib/workspace-api.generated.ts", import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, "utf8"));
const schemas = contract.components.schemas;

const lines = ["// Generated from backend/openapi.workspace.json. Do not edit.", ""];
for (const [name, schema] of Object.entries(schemas)) {
  lines.push(`export type ${name} = ${toType(schema)};`, "");
}
await writeFile(fileURLToPath(outputUrl), `${lines.join("\n")}\n`);

function toType(schema) {
  if (schema.$ref) return schema.$ref.split("/").at(-1);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map((type) => toType({ ...schema, type })).join(" | ");
  if (schema.type === "array") return `Array<${toType(schema.items)}> `;
  if (schema.type === "object") {
    if (schema.additionalProperties === true) return "Record<string, unknown>";
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {}).map(
      ([key, value]) => `  ${key}${required.has(key) ? "" : "?"}: ${toType(value)};`,
    );
    return `{\n${properties.join("\n")}\n}`;
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  return "string";
}
