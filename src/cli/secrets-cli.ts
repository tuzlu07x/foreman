import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import {
  SecretAlreadyExistsError,
  SecretNotFoundError,
  SecretStore,
} from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, red } from "./colors.js";

interface AddOptions {
  value?: string;
}

interface ShowOptions {
  yesIWantToSeeIt?: boolean;
  json?: boolean;
}

interface ListOptions {
  json?: boolean;
}

interface RemoveOptions {
  yes?: boolean;
}

interface RotateOptions {
  value?: string;
}

function getStore(): SecretStore {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") + `Foreman is not initialised. Run 'foreman init' first.`,
    );
    process.exit(1);
  }
  return new SecretStore(getDb(), loadOrCreateSecretsMasterKey());
}

export async function readSecretValueFromStdin(
  prompt: string,
): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    process.stderr.write(prompt);
    return readSilent();
  }
  return readAllStdin();
}

function readSilent(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    stdin.setEncoding("utf8");
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          finish();
          return;
        }
        if (code === 3) {
          stdin.setRawMode?.(false);
          stdin.removeListener("data", onData);
          stdin.pause();
          reject(new Error("aborted"));
          return;
        }
        if (code === 127 || code === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const finish = (): void => {
      stdin.setRawMode?.(false);
      stdin.removeListener("data", onData);
      stdin.pause();
      process.stderr.write("\n");
      resolve(value);
    };
    stdin.on("data", onData);
  });
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string | Buffer) => {
      chunks.push(typeof c === "string" ? c : c.toString("utf8"));
    });
    process.stdin.on("end", () => resolve(chunks.join("").replace(/\n$/, "")));
  });
}

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export const secretsCommand = new Command("secrets").description(
  "Encrypted secret store (add / list / show / remove / rotate)",
);

secretsCommand
  .command("add <name>")
  .description("Store a new secret (prompts for value)")
  .option("--value <value>", "supply value via flag instead of prompting")
  .action(async (name: string, options: AddOptions) => {
    const store = getStore();
    try {
      const value =
        options.value ?? (await readSecretValueFromStdin(`Value for ${name}: `));
      if (value.length === 0) {
        console.error(red("error: ") + "empty secret value");
        process.exit(1);
      }
      store.add(name, value);
      console.log(green("✓") + ` stored secret "${name}"`);
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

secretsCommand
  .command("list", { isDefault: true })
  .description("List secret names (never values)")
  .option("--json", "output JSON")
  .action((options: ListOptions) => {
    const store = getStore();
    const rows = store.list();
    if (options.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else if (rows.length === 0) {
      console.log("(no secrets stored)");
    } else {
      for (const r of rows) {
        const last = r.lastAccessedAt
          ? new Date(r.lastAccessedAt).toISOString()
          : "never";
        console.log(`${r.name}  ${dim(`last accessed: ${last}`)}`);
      }
    }
    closeDb();
  });

secretsCommand
  .command("show <name>")
  .description("Print a secret value (requires --yes-i-want-to-see-it)")
  .option(
    "--yes-i-want-to-see-it",
    "confirm you really want to print the value to your terminal",
  )
  .option("--json", "output JSON")
  .action((name: string, options: ShowOptions) => {
    const store = getStore();
    if (!options.yesIWantToSeeIt) {
      console.error(
        red("error: ") +
          "refusing to print without --yes-i-want-to-see-it (guards typo'd commands)",
      );
      closeDb();
      process.exit(1);
    }
    try {
      const value = store.get(name);
      if (options.json) {
        process.stdout.write(JSON.stringify({ name, value }, null, 2) + "\n");
      } else {
        process.stdout.write(value + "\n");
      }
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

secretsCommand
  .command("remove <name>")
  .description("Remove a secret")
  .option("--yes", "skip confirmation prompt")
  .action(async (name: string, options: RemoveOptions) => {
    const store = getStore();
    try {
      if (!options.yes) {
        const ok = await promptYesNo(`Remove secret "${name}"? [y/N]`);
        if (!ok) {
          console.log("(cancelled)");
          return;
        }
      }
      store.remove(name);
      console.log(green("✓") + ` removed secret "${name}"`);
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

secretsCommand
  .command("rotate <name>")
  .description("Replace the value of an existing secret")
  .option("--value <value>", "supply value via flag instead of prompting")
  .action(async (name: string, options: RotateOptions) => {
    const store = getStore();
    try {
      const value =
        options.value ??
        (await readSecretValueFromStdin(`New value for ${name}: `));
      if (value.length === 0) {
        console.error(red("error: ") + "empty secret value");
        process.exit(1);
      }
      store.rotate(name, value);
      console.log(green("✓") + ` rotated secret "${name}"`);
    } catch (err) {
      handleStoreError(err);
    } finally {
      closeDb();
    }
  });

function handleStoreError(err: unknown): void {
  if (err instanceof SecretNotFoundError) {
    console.error(red("error: ") + `no secret named "${err.secretName}"`);
    process.exit(1);
  }
  if (err instanceof SecretAlreadyExistsError) {
    console.error(
      red("error: ") +
        `secret "${err.secretName}" already exists — use 'foreman secrets rotate' to replace it`,
    );
    process.exit(1);
  }
  throw err;
}
