// The ambient inputs every command reads, passed explicitly so tests can
// drive a command against a temp HOME / project directory and capture its
// output without touching the real host or stubbing globals. The dispatcher
// fills this from `process` for the real binary.

export interface CliEnv {
  home: string;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function processEnv(): CliEnv {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return {
    home,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}
