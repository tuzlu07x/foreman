-- Hand-written migration: the original FTS triggers (0001) indexed only
-- `args || result`. That made `foreman log search` miss every term the user
-- could actually see in `log tail`: source agent, target tool, decision,
-- risk reasons. This migration drops the old triggers, recreates them with
-- richer content, and rebuilds the FTS for existing rows. (#217)

DROP TRIGGER IF EXISTS `requests_ai_fts`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `requests_au_fts`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `requests_ad_fts`;
--> statement-breakpoint
CREATE TRIGGER `requests_ai_fts` AFTER INSERT ON `requests` BEGIN
  INSERT INTO `requests_fts` (request_id, content)
  VALUES (
    new.id,
    new.source_agent || ' ' ||
    coalesce(new.target_agent, '') || ' ' ||
    coalesce(new.target_tool, '') || ' ' ||
    new.decision || ' ' ||
    coalesce(new.risk_reasons, '') || ' ' ||
    new.args || ' ' ||
    coalesce(new.result, '')
  );
END;
--> statement-breakpoint
CREATE TRIGGER `requests_au_fts` AFTER UPDATE OF source_agent, target_agent, target_tool, decision, risk_reasons, args, result ON `requests` BEGIN
  UPDATE `requests_fts`
  SET content =
    new.source_agent || ' ' ||
    coalesce(new.target_agent, '') || ' ' ||
    coalesce(new.target_tool, '') || ' ' ||
    new.decision || ' ' ||
    coalesce(new.risk_reasons, '') || ' ' ||
    new.args || ' ' ||
    coalesce(new.result, '')
  WHERE request_id = new.id;
END;
--> statement-breakpoint
CREATE TRIGGER `requests_ad_fts` AFTER DELETE ON `requests` BEGIN
  DELETE FROM `requests_fts` WHERE request_id = old.id;
END;
--> statement-breakpoint
DELETE FROM `requests_fts`;
--> statement-breakpoint
INSERT INTO `requests_fts` (request_id, content)
SELECT
  id,
  source_agent || ' ' ||
  coalesce(target_agent, '') || ' ' ||
  coalesce(target_tool, '') || ' ' ||
  decision || ' ' ||
  coalesce(risk_reasons, '') || ' ' ||
  args || ' ' ||
  coalesce(result, '')
FROM `requests`;
