import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  driver: "better-sqlite",
  dbCredentials: {
    url: "./foreman.db",
  },
  verbose: true,
  strict: true,
} satisfies Config;
