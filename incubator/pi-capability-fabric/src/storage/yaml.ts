import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function decodeYaml(text: string): unknown {
  return parseYaml(text);
}

export function encodeYaml(value: unknown): string {
  return stringifyYaml(value);
}
