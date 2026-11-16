import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Io, run } from "../src/run.js";

export const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const readFixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(fixture(name), "utf8"));

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in-process with captured output. */
export async function runCli(
  argv: string[],
  options: { stdin?: string; cwd?: string } = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let stdinRead = false;
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => {
      if (stdinRead) throw new Error("stdin read twice");
      stdinRead = true;
      return options.stdin ?? "";
    },
    cwd: options.cwd ?? process.cwd(),
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}
