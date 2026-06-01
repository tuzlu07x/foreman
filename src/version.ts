import pkg from "../package.json" with { type: "json" };

export const FOREMAN_VERSION: string = pkg.version;
