-- Hand-written migration: drizzle-kit can't emit FTS5 virtual tables.
-- Keeps requests_fts in sync with the requests table via triggers.

CREATE VIRTUAL TABLE `requests_fts` USING fts5(
  request_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `requests_ai_fts` AFTER INSERT ON `requests` BEGIN
  INSERT INTO `requests_fts` (request_id, content)
  VALUES (new.id, new.args || ' ' || coalesce(new.result, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `requests_au_fts` AFTER UPDATE OF args, result ON `requests` BEGIN
  UPDATE `requests_fts`
  SET content = new.args || ' ' || coalesce(new.result, '')
  WHERE request_id = new.id;
END;
--> statement-breakpoint
CREATE TRIGGER `requests_ad_fts` AFTER DELETE ON `requests` BEGIN
  DELETE FROM `requests_fts` WHERE request_id = old.id;
END;
