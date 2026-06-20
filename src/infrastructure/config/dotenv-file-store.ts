import { readFile, writeFile } from "node:fs/promises";
import type { EnvStorePort } from "../../application/ports/env-store.js";

/**
 * Comment-preserving .env reader/writer. Updates existing keys in place,
 * appends new ones, and leaves comments, blank lines and ordering untouched.
 * Writes are serialized through an in-process promise chain to avoid
 * interleaved read-modify-write races.
 */
export class DotenvFileStore implements EnvStorePort {
  private writeChain: Promise<unknown> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async read(): Promise<Record<string, string>> {
    const lines = await this.readLines();
    const values: Record<string, string> = {};
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed !== undefined) {
        values[parsed.key] = parsed.value;
      }
    }
    return values;
  }

  public async setMany(values: Record<string, string>): Promise<readonly string[]> {
    return this.serialize(async () => {
      const lines = await this.readLines();
      const written: string[] = [];

      for (const [key, value] of Object.entries(values)) {
        const formatted = `${key}=${formatValue(value)}`;
        const index = lines.findIndex((line) => parseLine(line)?.key === key);
        if (index >= 0) {
          lines[index] = formatted;
        } else {
          lines.push(formatted);
        }
        written.push(key);
      }

      await writeFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
      return written;
    });
  }

  public async presence(keys: readonly string[]): Promise<Record<string, boolean>> {
    const values = await this.read();
    const result: Record<string, boolean> = {};
    for (const key of keys) {
      result[key] = (values[key] ?? "").length > 0;
    }
    return result;
  }

  private async readLines(): Promise<string[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const lines = content.split("\n");
      // Drop a single trailing empty line produced by the trailing newline.
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      return lines;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}

interface ParsedLine {
  readonly key: string;
  readonly value: string;
}

function parseLine(line: string): ParsedLine | undefined {
  const trimmed = line.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }
  const equals = line.indexOf("=");
  if (equals < 0) {
    return undefined;
  }
  const key = line.slice(0, equals).trim();
  if (key.length === 0) {
    return undefined;
  }
  return { key, value: unquote(line.slice(equals + 1).trim()) };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\n", "\n");
  }
  return value;
}

function formatValue(value: string): string {
  if (/[\s#"'\n]/.test(value)) {
    return `"${value.replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
  }
  return value;
}
