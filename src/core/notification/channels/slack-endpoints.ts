// =============================================================================
// Where Foreman reaches Slack
// =============================================================================
//
// Always slack.com over TLS: the Web API, `hooks.slack.com` reply URLs and a
// `wss://` Socket Mode connection.
//
// The one exception is Foreman's own end-to-end QA suite (docs/qa.md), which
// runs a fake Slack on this machine (qa/support/fake-slack.ts) against the
// built CLI. For that, and nothing else, FOREMAN_TEST_SLACK_ORIGIN may name
// the fake: exactly `http://127.0.0.1:<port>`. Then the Web API is
// `<origin>/api`, reply URLs must start with `<origin>/hooks/` (and nothing
// else is posted to), and the socket URL must be `ws://127.0.0.1:<port>/…`.
// Any other value is ignored, so the override can never send a token, a
// tool call or a reply anywhere but this machine.

export const TEST_SLACK_ORIGIN_ENV = "FOREMAN_TEST_SLACK_ORIGIN";

export interface SlackEndpoints {
  /** Web API base, without a trailing slash. */
  api: string;
  /** A `response_url` must start with this, or no reply is posted. */
  replyUrlPrefix: string;
  /** A Socket Mode URL from `apps.connections.open` must start with this. */
  socketUrlPrefix: string;
}

export const SLACK_ENDPOINTS: SlackEndpoints = {
  api: "https://slack.com/api",
  replyUrlPrefix: "https://hooks.slack.com/",
  socketUrlPrefix: "wss://",
};

export function slackEndpoints(env: NodeJS.ProcessEnv = process.env): SlackEndpoints {
  const origin = testOrigin(env[TEST_SLACK_ORIGIN_ENV]);
  if (!origin) return SLACK_ENDPOINTS;
  return {
    api: `${origin}/api`,
    replyUrlPrefix: `${origin}/hooks/`,
    socketUrlPrefix: `ws://${origin.slice("http://".length)}/`,
  };
}

function testOrigin(raw: string | undefined): string | null {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(raw ?? "");
  const port = Number(match?.[1]);
  return match && port <= 65_535 ? `http://127.0.0.1:${port}` : null;
}
