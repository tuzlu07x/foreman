import { spawn } from "node:child_process";

export function launchEditor(filePath: string): Promise<number> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => reject(err));
  });
}
