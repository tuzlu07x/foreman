import { ConfirmInput, PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { type JSX, useState } from "react";
import {
  CHAT_APP_NAME,
  CHAT_APP_TOKEN,
  findTelegramChat,
  restartHint,
  saveChatApp,
  sendChatAppTest,
  SLACK_APP_TOKEN,
  TWO_WAY_GUIDE,
  type ChatAppId,
  type ChatAppValues,
  type TelegramChat,
  type TestResult,
} from "../../core/notification/chat-app-setup.js";
import type { ChannelToggle } from "../../core/notification/notify-config.js";
import {
  checkDiscordBot,
  checkSlackAppToken,
  checkSlackBot,
  checkTelegramBot,
  discordInviteUrl,
  type TokenCheck,
} from "../../core/notification/token-checks.js";
import type { ServiceEntry } from "../../core/registry-catalog.js";
import type { SecretStore } from "../../core/secret-store.js";
import { osc8 } from "../osc8.js";
import { servicePasteWarning } from "../setup-wizard/paste-checks.js";
import { roundBorder, theme } from "../theme.js";

// =============================================================================
// Services → set up a chat app, from the token to a test message
// =============================================================================
//
// Each step explains what to do in the chat app and checks the value with the
// app itself when it can, so a wrong paste shows up here and not as a silence
// when an approval is due. Nothing is saved until the last step.

/** What the flow talks to; tests pass fakes. */
export interface ChatAppApi {
  checkToken: (id: ChatAppId, token: string) => Promise<TokenCheck<{ username: string | null; id?: string | null }>>;
  checkSlackAppToken: (token: string) => Promise<TokenCheck>;
  findTelegramChat: (token: string) => Promise<TokenCheck<TelegramChat | null>>;
  test: (id: ChatAppId, toggle: ChannelToggle) => Promise<TestResult>;
}

/** The real thing, given how to sign what a two-way channel renders. */
export function chatAppApi(deps: Parameters<typeof sendChatAppTest>[2]): ChatAppApi {
  return {
    checkToken: (id, token) =>
      id === "telegram" ? checkTelegramBot(token) : id === "slack" ? checkSlackBot(token) : checkDiscordBot(token),
    checkSlackAppToken: (token) => checkSlackAppToken(token),
    findTelegramChat: (token) => findTelegramChat(token),
    test: (id, toggle) => sendChatAppTest(id, toggle, deps, "the Services page"),
  };
}

type Stage =
  | { kind: "token" }
  | { kind: "telegram-chat" }
  | { kind: "telegram-confirm"; chat: TelegramChat }
  | { kind: "target" }
  | { kind: "app-token" }
  | { kind: "user" }
  | { kind: "busy"; what: string };

const SLACK_USER = /^[UW][A-Z0-9]{2,39}$/i;
const DISCORD_ID = /^\d{5,25}$/;

export interface ChatAppConnectProps {
  id: ChatAppId;
  service: ServiceEntry;
  store: SecretStore;
  notifyConfigPath: string;
  api: ChatAppApi;
  /** A background service owns the channels (restart differs). */
  attached: boolean;
  /** Where the channel posts today, to keep on a re-run. */
  currentTarget?: string | undefined;
  onDone: (message: string) => void;
}

export function ChatAppConnect(props: ChatAppConnectProps): JSX.Element {
  const { id, service, store, api } = props;
  const name = CHAT_APP_NAME[id];
  const hasToken = store.exists(CHAT_APP_TOKEN[id]);
  const [stage, setStage] = useState<Stage>({ kind: "token" });
  const [values, setValues] = useState<ChatAppValues>({});
  const [bot, setBot] = useState<{ username: string | null; id?: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);

  const tokenInUse = (): string => values.token ?? store.get(CHAT_APP_TOKEN[id], { touch: false });
  const fail = (text: string, back: Stage): void => {
    setProblem(text);
    setStage(back);
  };

  const finish = async (all: ChatAppValues): Promise<void> => {
    setProblem(null);
    setStage({ kind: "busy", what: `Saving, then sending a test message to ${name}…` });
    try {
      const toggle = saveChatApp(id, all, { store, notifyConfigPath: props.notifyConfigPath });
      const result = await api.test(id, toggle);
      props.onDone(
        result.ok
          ? `✓ ${name} is connected: look for the test message there. ${restartHint(props.attached)}`
          : `${name} is saved, but the test message failed. ${result.reason}`,
      );
    } catch (err) {
      props.onDone(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const afterToken = (): void => setStage({ kind: id === "telegram" ? "telegram-chat" : "target" });

  const submitToken = async (raw: string): Promise<void> => {
    const value = raw.trim();
    setProblem(null);
    if (!value) {
      if (hasToken) return afterToken();
      setProblem(`Paste the token, or press Esc to cancel.`);
      return;
    }
    const warning = servicePasteWarning(CHAT_APP_TOKEN[id], value);
    if (warning && held !== value) {
      setHeld(value);
      setProblem(`${warning} Press Enter again to use it anyway.`);
      return;
    }
    setHeld(null);
    setStage({ kind: "busy", what: `Checking the token with ${name}…` });
    const check = await api.checkToken(id, value);
    if (check.status === "rejected") {
      fail(`${name} rejected that token${check.detail ? ` (${check.detail})` : ""}. Copy it again.`, { kind: "token" });
      return;
    }
    if (check.status === "ok") setBot(check.value);
    setValues((v) => ({ ...v, token: value }));
    if (check.status === "unreachable") setProblem(`Couldn't reach ${name} to check the token. Saving it anyway.`);
    afterToken();
  };

  const submitChat = async (raw: string): Promise<void> => {
    const typed = raw.trim();
    setProblem(null);
    if (typed) {
      if (!/^-?\d+$/.test(typed)) {
        setProblem("A chat id is a number, like 123456789.");
        return;
      }
      await finish({ ...values, chatId: typed });
      return;
    }
    setStage({ kind: "busy", what: "Looking for your message…" });
    const found = await api.findTelegramChat(tokenInUse());
    if (found.status !== "ok") {
      fail(`Couldn't read the bot's messages${found.detail ? ` (${found.detail})` : ""}. Type your chat id instead.`, { kind: "telegram-chat" });
    } else if (!found.value) {
      fail("No message yet. Send your bot any message in Telegram, then press Enter again.", { kind: "telegram-chat" });
    } else {
      setStage({ kind: "telegram-confirm", chat: found.value });
    }
  };

  const submitTarget = (raw: string): void => {
    const target = raw.trim() || props.currentTarget || (id === "slack" ? "#foreman" : "");
    setProblem(null);
    if (id === "discord" && !DISCORD_ID.test(target)) {
      setProblem("A Discord channel id is a long number: right-click the channel → Copy Channel ID.");
      return;
    }
    setValues((v) => ({ ...v, target }));
    setStage({ kind: id === "slack" ? "app-token" : "user" });
  };

  const submitAppToken = async (raw: string): Promise<void> => {
    const value = raw.trim();
    setProblem(null);
    if (!value) {
      await finish(values);
      return;
    }
    if (!value.startsWith("xapp-")) {
      setProblem("That isn't an app-level token: it starts with xapp-. Press Enter on an empty line to skip two-way.");
      return;
    }
    setStage({ kind: "busy", what: "Checking the app-level token with Slack…" });
    const check = await api.checkSlackAppToken(value);
    if (check.status === "rejected") {
      fail(`Slack rejected that token${check.detail ? ` (${check.detail})` : ""}. It needs the connections:write scope.`, { kind: "app-token" });
      return;
    }
    setValues((v) => ({ ...v, appToken: value }));
    setStage({ kind: "user" });
  };

  const submitUser = async (raw: string): Promise<void> => {
    const value = raw.trim();
    setProblem(null);
    if (!value) {
      const { appToken: _skipped, ...rest } = values;
      await finish(rest);
      return;
    }
    if (!(id === "slack" ? SLACK_USER : DISCORD_ID).test(value)) {
      setProblem(id === "slack" ? "A member id looks like U0123ABCD." : "A Discord user id is a long number.");
      return;
    }
    await finish({ ...values, userId: value });
  };

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle={roundBorder()} borderColor={theme.accent.primary}>
      <Text bold color={theme.accent.primary}>
        Set up {name}
        {bot?.username ? <Text color={theme.fg.muted}> · bot @{bot.username}</Text> : null}
      </Text>
      {stage.kind === "busy" ? <Text color={theme.fg.muted}>{stage.what}</Text> : null}

      {stage.kind === "token" ? (
        <>
          {/* The optional scopes stay in the guide (w): this has to fit a terminal. */}
          <Steps lines={service.setup_steps.filter((line) => !/^Optional|^\s*\[ \]/.test(line))} />
          {service.where_to_get ? (
            <Text color={theme.fg.muted}>
              Open: <Text color={theme.accent.primary}>{osc8(service.where_to_get)}</Text>
            </Text>
          ) : null}
          <Text>
            Paste the bot token{hasToken ? " (Enter keeps the one you saved)" : ""}:
          </Text>
          <PasswordInput key="token" placeholder={service.format_hint} onSubmit={(v) => void submitToken(v)} />
        </>
      ) : null}

      {stage.kind === "telegram-chat" ? (
        <>
          <Steps
            lines={[
              `Open ${bot?.username ? `@${bot.username}` : "your bot"} in Telegram and press Start`,
              "Send it any message, like hi",
              "Press Enter here, and Foreman finds your chat",
            ]}
          />
          <Text color={theme.fg.muted}>Or type your chat id:</Text>
          <TextInput key="chat" placeholder="Enter finds it" onSubmit={(v) => void submitChat(v)} />
        </>
      ) : null}

      {stage.kind === "telegram-confirm" ? (
        <>
          <Text>
            Found <Text bold>{stage.chat.name}</Text> (chat {stage.chat.chatId}). Approvals go to this chat. Is this you? (y/n)
          </Text>
          <ConfirmInput
            onConfirm={() => void finish({ ...values, chatId: stage.chat.chatId })}
            onCancel={() => fail("Then type your own chat id, or send the bot a message from your account.", { kind: "telegram-chat" })}
          />
        </>
      ) : null}

      {stage.kind === "target" && id === "slack" ? (
        <>
          <Steps
            lines={[
              "Create the channel in Slack, or pick one you have",
              `Open it and type: /invite @${bot?.username ?? "your-bot"}`,
              "Name it here (Enter keeps the one shown)",
            ]}
          />
          <TextInput key="target" defaultValue={props.currentTarget ?? "#foreman"} onSubmit={submitTarget} />
        </>
      ) : null}

      {stage.kind === "target" && id === "discord" ? (
        <>
          <Steps
            lines={[
              bot?.id ? `Add the bot to your server: ${discordInviteUrl(bot.id)}` : "Add the bot to your server: OAuth2 → URL Generator → scopes bot and applications.commands, permissions Send Messages and Embed Links",
              "Turn on Developer Mode: User Settings → Advanced",
              "Right-click the channel → Copy Channel ID, and paste it here",
            ]}
          />
          <TextInput key="target" {...(props.currentTarget ? { defaultValue: props.currentTarget } : {})} placeholder="123456789012345678" onSubmit={submitTarget} />
        </>
      ) : null}

      {stage.kind === "app-token" ? (
        <>
          <Text>Optional: approve with buttons and run /foreman in Slack.</Text>
          <Steps lines={TWO_WAY_GUIDE.slack} />
          <Text>
            Paste the app-level token (xapp-…), or press Enter to skip; Slack then only posts{store.exists(SLACK_APP_TOKEN) ? " unless you keep two-way below" : ""}:
          </Text>
          <PasswordInput key="app" placeholder="xapp-…" onSubmit={(v) => void submitAppToken(v)} />
        </>
      ) : null}

      {stage.kind === "user" ? (
        <>
          <Text>Who may press Allow / Deny and run /foreman? Only this user can.</Text>
          <Steps lines={id === "slack" ? ["In Slack click your profile picture → Profile → ⋮ (More) → Copy member ID"] : TWO_WAY_GUIDE.discord} />
          <Text color={theme.fg.muted}>Paste the id, or press Enter to skip; {name} then only posts:</Text>
          <TextInput key="user" placeholder={id === "slack" ? "U0123ABCD" : "111111111111111111"} onSubmit={(v) => void submitUser(v)} />
        </>
      ) : null}

      {problem ? <Text color={theme.accent.warning}>⚠ {problem}</Text> : null}
      {stage.kind === "busy" ? null : <Text color={theme.fg.muted}>[Enter] continue · [Esc] cancel, nothing is saved</Text>}
    </Box>
  );
}

function Steps({ lines }: { lines: readonly string[] }): JSX.Element {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={theme.fg.muted}>
          {"  "}
          {i + 1}. {line}
        </Text>
      ))}
    </Box>
  );
}
