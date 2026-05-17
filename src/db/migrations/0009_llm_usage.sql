-- C7 (#230): opt-in LLM provider config. Every call is logged here so the
-- budget tracker can sum cost over the current billing window. `cache_hit`
-- exists for C8/C9 to mark cached responses; aggregate stays accurate even
-- when responses come from cache (cost_usd = 0 on hits).

CREATE TABLE `llm_usage` (
  `id`             TEXT PRIMARY KEY NOT NULL,
  `ts`             INTEGER NOT NULL,
  `provider`       TEXT NOT NULL,
  `model`          TEXT NOT NULL,
  `feature`        TEXT NOT NULL,
  `input_tokens`   INTEGER NOT NULL,
  `output_tokens`  INTEGER NOT NULL,
  `cost_usd`       REAL NOT NULL,
  `request_id`     TEXT,
  `duration_ms`    INTEGER NOT NULL,
  `cache_hit`      INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `llm_usage_ts_idx` ON `llm_usage` (`ts`);
--> statement-breakpoint
CREATE INDEX `llm_usage_feature_idx` ON `llm_usage` (`feature`, `ts`);
