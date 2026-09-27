-- Approval escalation along reporting lines (#623).
--
-- With `approvals.escalate_via_manager: true` in org.yaml, a low- or
-- medium-risk approval an agent asks for is also sent to its manager agent
-- as a review request (a thread message). The manager may record one
-- recommendation (allow / deny + reason). A recommendation is advice shown
-- to the owner: it never resolves the approval, which stays in
-- `pending_approvals` until the owner decides or it times out.

CREATE TABLE `approval_reviews` (
  `approval_id` TEXT NOT NULL,
  `manager_role` TEXT NOT NULL,
  -- the agent filling manager_role when the review was sent (lowercase)
  `manager_agent` TEXT NOT NULL,
  `requester_role` TEXT NOT NULL,
  `requester_agent` TEXT NOT NULL,
  `target_tool` TEXT,
  `risk_score` INTEGER NOT NULL,
  -- low | medium (high and critical are never escalated)
  `risk_bucket` TEXT NOT NULL,
  -- the dm:<a>|<b> thread the review request was posted on
  `channel` TEXT NOT NULL,
  `message_id` TEXT,
  -- open until the approval is decided, times out or is withdrawn
  `status` TEXT NOT NULL DEFAULT 'open',
  `requested_at` INTEGER NOT NULL,
  `deadline_ms` INTEGER,
  `closed_at` INTEGER,
  -- allow | deny, set once by the manager
  `recommendation` TEXT,
  -- redacted and clipped
  `reason` TEXT,
  `recommended_at` INTEGER,
  -- set once `foreman start` has shown the recommendation to the owner
  `announced_at` INTEGER,
  PRIMARY KEY (`approval_id`, `manager_role`)
);
--> statement-breakpoint
CREATE INDEX `approval_reviews_unannounced_idx` ON `approval_reviews` (`announced_at`, `recommended_at`);
--> statement-breakpoint
CREATE INDEX `approval_reviews_status_idx` ON `approval_reviews` (`status`);
