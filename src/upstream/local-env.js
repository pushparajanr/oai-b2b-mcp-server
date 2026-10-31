import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function persistEnvValue(path, key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`Refusing to store a multiline value for ${key}`);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const updated = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(path, updated, { mode: 0o600 });
}
