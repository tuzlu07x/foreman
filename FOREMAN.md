# Foreman

**Your local AI agents talk to each other. You should know what they're saying.**

A terminal-first guardian that sits between your AI agents and makes sure none
of them does anything you didn't approve.

---

## 1. Bu Doküman Ne?

Bu, projenin **anahtar teslim** açıklamasıdır. Sırasıyla:

1. Projenin amacı ve neyi çözdüğü
2. Kullanılacak teknolojiler ve **neden** seçildikleri
3. Mimari (yüksek seviye + detay)
4. Veritabanı şeması
5. Backend servisleri (her biri ayrı ayrı)
6. MVP scope ve roadmap
7. Repo yapısı ve nasıl başlanır

Okuduğunda kafanda hem **niye** hem **nasıl** netleşmiş olmalı.

---

## 2. Projenin Amacı

### 2.1 Problem

Bugün bir kullanıcı tek bir AI agent kullanmıyor. Tipik bir power-user'ın
makinesinde şunlar var:

- **Hermes** veya **OpenClaw** (Telegram'dan ulaşan kişisel asistan)
- **Claude Code** (kod üzerinde çalışan agent)
- Bir veya birden fazla **custom agent** (Python script, MCP server, vs.)

Bu agent'ların **hepsi izole** çalışıyor:

- Her birinin kendi memory'si var, paylaşmıyorlar.
- Birbirine güvenli bir şekilde soru soramıyorlar.
- Kullanıcı, hangi agent'ın ne yaptığını **tek bir yerden göremiyor**.
- Bir agent zararlı bir komut alırsa (prompt injection, phishing) **arada
  duran bir kontrol katmanı yok**.

Sektör buraya gidiyor — Salesforce 2026 raporu: deploy edilmiş agent'ların
%50'si tamamen izole çalışıyor, organizasyon başına ortalama 12 agent var,
2 yılda bu sayı %67 artacak. Ama **agent'lar arasında güvenli bir aracı**
yok. Bu boşluk Foreman'ın doldurduğu yer.

### 2.2 Çözüm

Foreman, kullanıcının makinesinde çalışan, terminal-first bir **gateway**:

- Tüm local agent'lar Foreman'a kayıt olur.
- Agent'lar artık birbirini doğrudan değil, **Foreman üzerinden** çağırır.
- Her istek **risk skoru** alır.
- Yüksek riskli istekler kullanıcıya **terminal prompt** olarak gelir
  (`a`llow, `d`eny, `r`emember).
- Tüm trafik **SQLite'a loglanır** — sonradan denetlenebilir.

### 2.3 Tek Cümlede Konumlandırma

> **"Foreman: your local AI agents talk to each other. You should know what
> they're saying."**

OpenClaw'ın "AI'a Telegram'dan yaz" cümlesi nasıl bir slogansa, bu da öyle.

### 2.4 Hedef Kullanıcı

- Birden fazla AI agent kullanan developer / power-user
- Self-hosted AI ekosistemiyle ilgilenen kişiler (LocalLLaMA, Hermes,
  OpenClaw kullanıcıları)
- Mahremiyet konusunda titiz olanlar (verisi başkasının sunucusunda durmasın)

### 2.5 Hedef Olmayan Kullanıcı

- Tek bir agent kullanan, sade bir chatbot deneyimi yeten kullanıcı
- Cloud-managed agent platformu arayan enterprise (LangSmith, Helicone tarafı)
- Non-technical son kullanıcı (ilk versiyon CLI/TUI, GUI değil)

---

## 3. Teknoloji Seçimleri ve Gerekçeleri

Her seçimin bir nedeni var. Sırf "moda" diye değil.

### 3.1 Dil: TypeScript + Node.js

**Neden TypeScript:**

- Agent ekosistemi şu an JS/TS ağırlıklı. **MCP SDK**'nın resmi
  implementasyonu TypeScript var, en olgun olanı bu. Claude Agent SDK,
  OpenClaw — hepsi TS.
- Kullanıcı kurulumu kolay: `npm install -g foreman-agent`. Python'da
  `pip + venv + python version` derdi başlar; viral olma şansı düşer.
- Async/event-driven I/O modeli, **bir gateway** için biçilmiş kaftan
  (proxy pattern + WebSocket handling).
- TUI için **Ink** (React-for-CLI) çok olgun, Claude Code da kullanıyor.

**Neden Node.js (Bun değil):**

- Node ekosistemi olgun, kullanıcı zaten kurulu (Hermes/OpenClaw için
  zaten kurmuş oluyor).
- Bun harika ama bazı native modüller (better-sqlite3) hâlâ Node-first.
- v0.2 veya v0.3'te Bun'a geçilebilir; MVP için risk azaltıyoruz.

**TypeScript versiyonu:** 5.x, strict mode, ESM.

### 3.2 Runtime / Process Management: PM2 değil, sade systemd/launchd / foreman start

MVP'de basit: kullanıcı `foreman start` der, foreground process açılır.
Background daemon işini şimdilik çözmüyoruz — kullanıcı tmux/screen kullansın.
v0.2'de systemd unit file template'i veririz.

### 3.3 Protokol: MCP (Model Context Protocol)

**Neden MCP:**

- Anthropic'in açtığı, ama **vendor-neutral** bir standart. 2025'te patladı,
  şu an agent ↔ tool iletişiminin de-facto standardı (97M+ download).
- Foreman'ın agent'larla konuştuğu protokol bu olunca, mevcut tüm MCP-uyumlu
  agent'lar (Claude Code, Hermes, OpenClaw, custom MCP server'lar) **sıfır
  modifikasyon** ile Foreman'a bağlanabilir.
- Sıfırdan bir protokol uydursak kimse adopte etmez. MCP'nin doğal
  genişlemesi olarak konumlanıyoruz.

**Foreman MCP'yi iki şekilde kullanıyor:**

1. **MCP Server olarak**: Agent'lar Foreman'a "MCP client" olarak bağlanır.
   Foreman onlara "ben şu tool'ları sağlıyorum" der.
2. **MCP Proxy olarak**: Agent A başka bir MCP server'a (örn. dosya sistemi)
   ulaşmak istediğinde, Foreman üzerinden proxy'lenir. Foreman intercept
   eder, risk skorlar, gerekiyorsa onay sorar, sonra ya geçirir ya keser.

### 3.4 Transport: stdio + WebSocket

**stdio**: Local MCP server'lar zaten stdio kullanıyor (Claude Code'un
bağlandığı çoğu MCP server böyle). Agent stdin'den okuyor, stdout'a yazıyor.
Foreman bunu konuşabilmeli.

**WebSocket**: Network-based agent'lar (uzak Hermes instance'ı, custom HTTP
agent) için. v0.2'de cross-machine federation gelince zaten lazım olacak.

JSON-RPC 2.0 framing (MCP zaten bunu kullanıyor).

### 3.5 Veritabanı: SQLite + better-sqlite3

**Neden SQLite:**

- Local-first ürün → dosya tabanlı DB doğal. Postgres overkill.
- **Hermes de FTS5 SQLite** kullanıyor; ekosistem alışmış.
- Backup = tek dosya kopyala. Migration = standart SQL.
- Audit log için FTS5 full-text search built-in.

**Neden better-sqlite3 (sqlite3 değil):**

- Senkron API, hızlı (10x sqlite3'ten).
- Type-safe TypeScript binding'leri var.
- Single-process, single-threaded gateway için ideal.

**Migration tool:** [`drizzle-orm`](https://orm.drizzle.team/) +
[`drizzle-kit`](https://orm.drizzle.team/kit-docs/overview) — schema'yı
TypeScript'te tanımlıyorsun, drizzle-kit migration üretiyor.

### 3.6 Identity / Crypto: Ed25519 (Node `crypto` built-in)

**Neden Ed25519:**

- Modern, hızlı, küçük key boyutu (32 byte).
- Node.js'in `crypto` modülünde **built-in**, dependency yok.
- v0.2'de cross-machine federation gelince zaten lazım — şimdi koyalım,
  altyapı hazır olsun.

Her agent kayıt olduğunda bir key pair üretilir. Mesajlar agent tarafından
imzalanır, Foreman doğrular. Kullanıcının kendi master key'i de var (v0.2'de
multi-device için kullanılacak).

### 3.7 Policy: YAML (Cedar/OPA değil, henüz)

**Neden YAML:**

- Kullanıcı kendi elle düzenleyebilir.
- Versiyonlanabilir (git'e koyabilir).
- MVP için yeterli — declarative permission rules.

**Cedar/OPA değil neden:** MVP için over-engineering. v0.3'te ihtiyaç olursa
geçeriz. YAML'dan Cedar'a migrate kolay.

```yaml
# ~/.foreman/policy.yaml
agents:
  hermes:
    can_call:
      claude-code: [read_file, list_files]
    cannot_call:
      claude-code: [write_file, run_shell]
    rate_limits:
      messages_per_minute: 30
      tokens_per_hour: 100000
```

### 3.8 TUI: Ink (React for CLI)

**Neden Ink:**

- React component model, declarative.
- Claude Code'un kullandığı framework — kanıtlanmış UX.
- Live updating, scrollable lists, input handling hep var.
- TypeScript desteği birinci sınıf.

**Alternatifler değil neden:**

- `blessed`: eski, maintenance az.
- Sıfırdan ANSI escape: yeniden tekerleği icat.

### 3.9 Risk Scoring: Heuristic-first, LLM-optional

İlk versiyonda risk skoru **basit kurallarla** hesaplanır:

- Secret dosya pattern'i mi (`.env`, `*.key`, `id_rsa`)? → +50 risk puanı
- Outbound network call mı? → +30
- Shell exec mi? → +40
- İki agent arası ilk konuşma mı? → +20
- Daha önce reddedilmiş pattern mi? → +30

Toplam ≥ 50 → kullanıcıya sor. Yoksa otomatik geçir.

**v0.2'de:** Opsiyonel olarak küçük bir local LLM (Llama Prompt Guard 2,
86M param) ile prompt injection tespiti.

### 3.10 Audit Search: SQLite FTS5

Audit log'da full-text search için SQLite'ın FTS5 extension'ı. Built-in,
ekstra dependency yok.

```bash
foreman log search "config.json"
foreman log search "hermes AND claude-code"
```

### 3.11 Build & Packaging

- **tsup** veya **tsc + esbuild**: TypeScript → JS bundle.
- **npm publish**: `npm install -g foreman-agent` ile global CLI.
- Single binary için v0.3'te `pkg` veya Bun build düşünülebilir.

### 3.12 Test

- **Vitest**: Hızlı, ESM-native, TypeScript-first.
- **MSW**: MCP mesajları için mock server.

---

## 4. Mimari — Yüksek Seviye

```
┌──────────────────────────────────────────────────────────────┐
│                     Foreman (single process)                 │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Registry    │    │  Mediator    │    │  Policy      │  │
│  │  Service     │    │  Service     │    │  Engine      │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │          │
│         └───────────┬───────┴───────────────────┘          │
│                     │                                       │
│  ┌──────────────┐   │   ┌──────────────┐  ┌────────────┐  │
│  │  Risk        │◄──┴──►│  Approval    │  │  Audit     │  │
│  │  Scorer      │       │  Service     │  │  Logger    │  │
│  └──────────────┘       └──────┬───────┘  └─────┬──────┘  │
│                                │                │          │
│                                ▼                ▼          │
│                          ┌──────────┐    ┌──────────┐     │
│                          │   TUI    │    │  SQLite  │     │
│                          │  (Ink)   │    │  (FTS5)  │     │
│                          └──────────┘    └──────────┘     │
└─────────▲────────────────────────────────────────▲─────────┘
          │                                        │
          │ MCP (stdio/WS)                         │ MCP
          │                                        │
   ┌──────┴──────┐                          ┌─────┴──────┐
   │   Hermes    │                          │ Claude Code│
   └─────────────┘                          └────────────┘
```

**Önemli yapı taşları:**

- **Tek process**, tüm servisler aynı Node.js process'inde yaşar.
- **In-memory event bus** ile servisler haberleşir (EventEmitter veya
  basit pub/sub).
- Persistance sadece SQLite.
- Agent'lar Foreman'a **MCP protokolü** üzerinden bağlanır.

---

## 5. Veritabanı Şeması

SQLite, drizzle-orm ile TypeScript-defined schema.

### 5.1 `agents` — Kayıtlı agent'lar

```typescript
agents (
  id              TEXT PRIMARY KEY,         // "hermes", "claude-code", "my-script"
  display_name    TEXT NOT NULL,            // "Hermes Personal Assistant"
  public_key      BLOB NOT NULL,            // Ed25519 public key (32 bytes)
  transport       TEXT NOT NULL,            // "stdio" | "ws"
  endpoint        TEXT,                     // websocket URL or process command
  registered_at   INTEGER NOT NULL,         // unix ms
  last_seen_at    INTEGER,                  // unix ms
  status          TEXT NOT NULL,            // "active" | "inactive" | "blocked"
  metadata        TEXT                      // JSON blob: version, capabilities, etc
)
```

**Niye:** Her agent'ın kimliği. `public_key` ile mesajlar doğrulanır.

### 5.2 `policies` — İzin kuralları

```typescript
policies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_agent    TEXT NOT NULL,            // "hermes" or "*" for any
  target          TEXT NOT NULL,            // "claude-code:read_file" or "tool:shell_exec"
  effect          TEXT NOT NULL,            // "allow" | "deny" | "ask"
  conditions      TEXT,                     // JSON: rate limits, time windows, patterns
  created_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL,            // "user" | "remember-action"
  enabled         INTEGER NOT NULL DEFAULT 1
)
```

**Niye:** YAML policy dosyası yüklendiğinde buraya açılır. "Remember"
basıldığında yeni satır eklenir. Lookup hızlı (indexed).

**Index:** `(source_agent, target, enabled)` üstüne.

### 5.3 `requests` — Her interception

```typescript
requests (
  id              TEXT PRIMARY KEY,         // ulid
  source_agent    TEXT NOT NULL,
  target_agent    TEXT,                     // agent-to-agent ise dolu
  target_tool     TEXT,                     // hangi tool/method
  args            TEXT NOT NULL,            // JSON: çağrı parametreleri
  risk_score      INTEGER NOT NULL,
  risk_reasons    TEXT,                     // JSON array: ["secret_file", "outbound"]
  decision        TEXT NOT NULL,            // "allowed" | "denied" | "pending"
  decided_by      TEXT,                     // "policy:42" | "user" | "auto"
  result          TEXT,                     // JSON: agent'ın döndüğü cevap (allow ise)
  duration_ms     INTEGER,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
)
```

**Niye:** Audit'in kalbi. Her şey buraya yazılır.

**Index:** `(source_agent, created_at)`, `(decision, created_at)`.

### 5.4 `requests_fts` — Full-text search

```typescript
requests_fts (
  request_id,
  content,                                  // args + result concatenated
  // FTS5 virtual table
)
```

**Niye:** `foreman log search "config.json"` için. FTS5 trigger ile
`requests` insert'ten otomatik dolar.

### 5.5 `sessions` — Konuşma bağlamları

```typescript
sessions (
  id              TEXT PRIMARY KEY,
  participants    TEXT NOT NULL,            // JSON array: ["hermes", "claude-code"]
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  message_count   INTEGER NOT NULL DEFAULT 0,
  token_count     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL             // "active" | "completed" | "halted"
)
```

**Niye:** İki agent arası "konuşma" bir session. Loop guard ve token budget
için lazım. 5 turdan fazla devam ederse halt edilir.

### 5.6 `audit_events` — Sistem olayları

```typescript
audit_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type      TEXT NOT NULL,            // "agent_registered", "policy_changed", "session_halted"
  payload         TEXT NOT NULL,            // JSON
  created_at      INTEGER NOT NULL
)
```

**Niye:** Request'ler dışındaki sistem olayları. Policy değiştirildi,
agent eklendi, kullanıcı master key rotate etti vs.

---

## 6. Backend Servisleri (Tek Tek)

Hepsi aynı process'te, in-memory event bus ile haberleşir. Her biri ayrı
TypeScript modülü.

### 6.1 RegistryService

**Sorumluluk:** Agent'ları kayıt et, kimliklerini yönet, online/offline
durumlarını takip et.

**Ne yapar:**

- `register(manifest)` — yeni agent kayıt eder, key pair üretir, DB'ye yazar
- `authenticate(agentId, signature)` — gelen mesajın imzasını doğrular
- `list()` — aktif agent'ları döner (TUI için)
- `heartbeat(agentId)` — last_seen güncellenir

**Nerede kullanır:**

- Foreman start olduğunda kayıtlı agent'ları yükler
- Yeni agent bağlandığında çağrılır
- TUI'de "Registered agents" listesi için

**Tablolar:** `agents`

### 6.2 MediatorService

**Sorumluluk:** Agent'lar arası mesaj akışını yönetir. Kalbi burası.

**Ne yapar:**

- Agent A'dan gelen request'i alır
- PolicyEngine'e sorar: "bu hareket için kural var mı?"
- RiskScorer'a sorar: "risk skoru kaç?"
- Karar `allow` ise: target'a iletir, response'u geri taşır
- Karar `ask` ise: ApprovalService'e devreder
- Karar `deny` ise: çağıran agent'a error döner
- Her şeyi AuditLogger'a bildirir

**Nerede kullanır:** Her MCP isteğinde.

**Tablolar:** Sadece okur (DB'ye yazma işini AuditLogger yapar).

### 6.3 PolicyEngine

**Sorumluluk:** "Bu istek için kayıtlı bir kural var mı?" cevabını verir.

**Ne yapar:**

- `evaluate(request)` → `{decision: 'allow' | 'deny' | 'ask', matchedRuleId?}`
- YAML policy dosyasını okur, parse eder, DB'ye yükler
- `remember()` çağrısıyla yeni kural ekler
- Conditions değerlendirir (rate limit, pattern match)

**Nerede kullanır:** Her MediatorService kararında.

**Tablolar:** `policies`

### 6.4 RiskScorer

**Sorumluluk:** Heuristic kurallarla bir istek için risk puanı hesaplar.

**Ne yapar:**

- `score(request)` → `{score: number, reasons: string[]}`
- Pattern matching: secret dosyaları, outbound URL, shell exec
- Heuristic kurallar ileride pluggable olur (her risk kategorisi ayrı dosya)

**Nerede kullanır:** PolicyEngine `ask` derse veya policy kuralı yoksa
default davranışı belirlemek için.

**Tablolar:** Yok (stateless).

### 6.5 ApprovalService

**Sorumluluk:** Kullanıcıya terminal'de onay sorar, cevabı bekler.

**Ne yapar:**

- TUI'ye `pendingApproval` event'i gönderir
- TUI'den `approved` / `denied` / `remembered` event'i alır
- Eğer kullanıcı 60 saniye cevap vermezse default policy uygulanır
  (default = `deny`, configurable)
- "Remember" seçilirse PolicyEngine'e yeni kural kaydeder

**Nerede kullanır:** MediatorService `ask` kararı verdiğinde.

**Tablolar:** Yok doğrudan (PolicyEngine üzerinden yazar).

### 6.6 AuditLogger

**Sorumluluk:** Her olayı SQLite'a yazar. FTS5 index'i günceller.

**Ne yapar:**

- `logRequest(request, decision, result)` → `requests` + `requests_fts`
- `logEvent(type, payload)` → `audit_events`
- Async batch write (her request için ayrı transaction değil, 100ms
  buffer ile batch)

**Nerede kullanır:** Her servis tarafından (event bus aracılığıyla).

**Tablolar:** `requests`, `requests_fts`, `audit_events`

### 6.7 SessionManager

**Sorumluluk:** Agent-to-agent konuşmalarını "session" olarak gruplar.
Loop ve budget guard.

**Ne yapar:**

- `startSession(participants)` → session ID
- `recordTurn(sessionId, tokenCount)` — her mesajda
- Eğer `message_count > 5` veya `token_count > budget` → halt
- Halt olunca kullanıcıya bildirim, session ID ile devam veya iptal

**Nerede kullanır:** MediatorService agent-to-agent çağrılarda.

**Tablolar:** `sessions`

### 6.8 MCPGateway

**Sorumluluk:** Agent'larla MCP protokolü konuşur. Transport layer.

**Ne yapar:**

- stdio veya WebSocket üzerinden MCP server/client çalıştırır
- Gelen JSON-RPC mesajlarını parse eder, MediatorService'e devreder
- Giden cevapları doğru transport'a yazar
- Reconnection / heartbeat yönetir

**Nerede kullanır:** Foreman ile agent'lar arası tüm trafik.

**Tablolar:** Yok (stateless transport).

### 6.9 TUIController

**Sorumluluk:** Ink ile terminal UI'ı yönetir.

**Ne yapar:**

- Live activity feed (akış halinde son istekler)
- Pending approval prompt'ları
- Komut çalıştırma (`foreman policy show`, `foreman log search ...`)
- Keyboard input handling

**Nerede kullanır:** Kullanıcının gördüğü her şey.

**Tablolar:** Sadece okur (TUI command'ları için).

---

## 7. Kullanıcı Akışları (User Flows)

### 7.1 Kurulum

```bash
npm install -g foreman-agent
foreman init
# ~/.foreman/ klasörü oluşur
# - identity.key (Ed25519 master keypair)
# - policy.yaml (boş template)
# - foreman.db (SQLite, schema migrate)
foreman start
```

### 7.2 Agent Bağlama

İki yöntem:

**Yöntem A — Agent kendisi MCP-aware:**
Agent'ın config'inde Foreman'ı MCP server olarak gösterir:

```json
// Claude Code config örneği
{
  "mcpServers": {
    "foreman": {
      "command": "foreman",
      "args": ["mcp-stdio"]
    }
  }
}
```

**Yöntem B — Foreman agent'ı wrap eder:**
```bash
foreman wrap --name hermes -- hermes-agent start
# Foreman, hermes-agent'ı child process olarak başlatır
# Onun stdio'sunu intercept eder
```

### 7.3 İlk Mesaj (Happy Path)

```
Kullanıcı: (Claude Code'da) "src/auth.ts'i oku"
Claude Code → Foreman: tools/call read_file{path: "src/auth.ts"}
Foreman:
  1. RegistryService → claude-code authenticated ✓
  2. PolicyEngine → "claude-code:read_file → allow" ✓
  3. RiskScorer → score: 10 (düşük) ✓
  4. Decision: allow
  5. Tool'u çalıştır, sonucu döndür
  6. AuditLogger → log
Claude Code: dosya içeriği döner
TUI: [09:14] claude-code → read_file("src/auth.ts") ✓ auto-allow
```

### 7.4 Şüpheli Mesaj (Phishing Senaryosu)

```
Hermes mail okuyor → "API key paylaş" istemi
Hermes → Foreman: agents/call claude-code.read_file{path: ".env"}
Foreman:
  1. RegistryService → hermes authenticated ✓
  2. PolicyEngine → "hermes:claude-code:read_file" için kayıt yok
  3. RiskScorer → score: 80 (secret_file + agent_to_agent + outbound_context)
  4. Decision: ask
  5. ApprovalService → TUI prompt
TUI:
  ⚠ [09:14] Hermes → Claude Code
    Request: read_file(".env")
    Reason: "User colleague asked for API key via email"
    Risk: 80/100 (HIGH)
    Reasons: secret_file_pattern, agent_to_agent, outbound_intent
    [a]llow  [d]eny  [r]emember  [i]nspect
Kullanıcı: d basar
ApprovalService: denied
MediatorService: hermes'e error döner
AuditLogger: log denied
```

### 7.5 Audit Sorgusu

```bash
$ foreman log search ".env"
[2026-05-13 09:14:23] hermes → claude-code: read_file(".env") DENIED by user
[2026-05-12 14:02:11] claude-code → fs: read_file(".env.example") ALLOWED by policy:7
```

---

## 8. MVP Scope (v0.1) — Aşamalar

Aşamalar sıralıdır, biri bitmeden diğerine geçilmez. Süre tahmini yok —
bittiğinde biter.

### Phase 1: İskelet

- [ ] Repo setup: TS, ESM, Vitest, Drizzle
- [ ] CLI entry point (`foreman init`, `foreman start`)
- [ ] SQLite schema + migrations
- [ ] RegistryService (basic agent registration)
- [ ] AuditLogger (basic write)

### Phase 2: Mediator + Policy

- [ ] MCPGateway stdio transport
- [ ] MediatorService basic flow
- [ ] PolicyEngine YAML loader
- [ ] RiskScorer with heuristic rules
- [ ] ApprovalService console prompt (basic, no TUI yet)

### Phase 3: TUI + Audit

- [ ] Ink-based TUI
- [ ] Live activity feed
- [ ] Approval prompts in TUI
- [ ] `foreman log search` command
- [ ] `foreman policy show/edit` commands

### Phase 4: Demo + Release

- [ ] Reference setup: Claude Code + custom mock agent integration
- [ ] Asciinema cast of phishing scenario
- [ ] README polish
- [ ] npm publish v0.1.0
- [ ] Soft launch: HN, r/LocalLLaMA, Twitter, Discord

### v0.1'de OLMAYACAK (Açıkça)

- Cross-machine federation
- Local LLM-based prompt injection detection
- GUI dashboard
- Cedar/OPA policy
- Plugin system
- Token cost optimization (router layer)

Bunlar v0.2+ konusu. **MVP'yi kirletmeyelim.**

---

## 9. Roadmap (Bilgi Amaçlı, MVP Sonrası)

### v0.2 — Cross-machine Mesh

- `foreman link` komutu
- Tailscale opsiyonel entegrasyonu
- Master key + child key sistemi
- Primary device approval flow

### v0.3 — Smart Risk

- Llama Prompt Guard 2 entegrasyonu (opsiyonel)
- LLM-based intent classification (router layer)
- Token budget enforcement

### v0.4 — Ecosystem

- Plugin API
- Cedar policy support
- Hermes / OpenClaw için resmi adapter'lar
- Web dashboard (opsiyonel, local-only)

---

## 10. Repo Yapısı

```
foreman/
├── README.md
├── FOREMAN.md                 # bu doküman
├── LICENSE                     # MIT
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── vitest.config.ts
│
├── src/
│   ├── cli/
│   │   ├── index.ts           # entry point, command parsing
│   │   ├── init.ts            # foreman init
│   │   ├── start.ts           # foreman start
│   │   ├── log.ts             # foreman log ...
│   │   └── policy.ts          # foreman policy ...
│   │
│   ├── core/
│   │   ├── registry.ts        # RegistryService
│   │   ├── mediator.ts        # MediatorService
│   │   ├── policy-engine.ts   # PolicyEngine
│   │   ├── risk-scorer.ts     # RiskScorer
│   │   ├── approval.ts        # ApprovalService
│   │   ├── audit.ts           # AuditLogger
│   │   ├── session.ts         # SessionManager
│   │   └── event-bus.ts       # in-memory pub/sub
│   │
│   ├── mcp/
│   │   ├── gateway.ts         # MCPGateway
│   │   ├── stdio-transport.ts
│   │   ├── ws-transport.ts
│   │   └── types.ts           # MCP message types
│   │
│   ├── db/
│   │   ├── schema.ts          # drizzle schema
│   │   ├── client.ts          # better-sqlite3 wrapper
│   │   └── migrations/        # drizzle-kit generated
│   │
│   ├── tui/
│   │   ├── app.tsx            # Ink root component
│   │   ├── activity-feed.tsx
│   │   ├── approval-prompt.tsx
│   │   └── components/
│   │
│   ├── identity/
│   │   ├── keypair.ts         # Ed25519 helpers
│   │   └── signing.ts
│   │
│   └── utils/
│       ├── config.ts          # ~/.foreman/ paths
│       └── logger.ts          # internal debug logger
│
├── tests/
│   ├── core/
│   ├── mcp/
│   └── integration/
│
└── examples/
    ├── mock-agent/            # demo için mock agent
    ├── policy-examples/
    └── phishing-scenario/     # asciinema script
```

---

## 11. Bağımlılıklar (package.json özeti)

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^x.x",  // MCP TypeScript SDK
    "better-sqlite3": "^11.x",
    "drizzle-orm": "^0.30.x",
    "ink": "^5.x",
    "react": "^18.x",                      // ink için
    "commander": "^12.x",                  // CLI parser
    "yaml": "^2.x",                        // policy YAML parser
    "ulid": "^2.x",                        // request ID üretimi
    "zod": "^3.x"                          // schema validation
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vitest": "^1.x",
    "drizzle-kit": "^0.20.x",
    "tsup": "^8.x",
    "@types/node": "^20.x",
    "@types/react": "^18.x"
  }
}
```

---

## 12. Başlangıç Adımları

Sıralı, küçük adımlar. Her adım kendi içinde tamamlanabilir.

### Adım 1: Repo aç

```bash
mkdir foreman && cd foreman
git init
npm init -y
# package.json'a yukarıdaki bağımlılıkları ekle
npm install
```

### Adım 2: README + LICENSE

- Bu dokümanı (FOREMAN.md) repo'ya commit'le
- README.md kısa ve viral yaz (yukarıdaki 2.3'teki cümleyle başla)
- LICENSE MIT ekle

### Adım 3: TypeScript + Drizzle setup

- `tsconfig.json` strict, ESM, Node20 target
- `drizzle.config.ts`
- `src/db/schema.ts` — yukarıdaki schema'yı drizzle ile yaz
- `npx drizzle-kit generate` ile migration üret
- İlk `migrate` çalıştır, foreman.db oluştuğunu gör

### Adım 4: Hello world

- `src/cli/index.ts` — commander ile `foreman init` ve `foreman start`
- `foreman init` → `~/.foreman/` oluştursun, schema migrate etsin
- `foreman start` → "Foreman v0.1.0 started" yazsın, exit

Buradan sonrası Phase 1'in geri kalanına devam.

---

## 13. Riskler ve Açık Kararlar

### 13.1 Bilinen Riskler

| Risk | Etki | Mitigation |
|------|------|------------|
| MCP SDK API'si hâlâ değişiyor | Orta | SDK version pin, breaking change'leri takip |
| Kullanıcılar henüz multi-agent kullanmıyor | Yüksek | Single-agent senaryosunda da değer üret (audit, observability) |
| Performance: her mesaj DB write | Düşük | AuditLogger batched, async |
| Approval prompt rahatsız edici olur | Orta | "remember" çok kolay, default'lar akıllı |
| TUI cross-platform sorunlar (Windows) | Düşük | İlk versiyon Mac/Linux focus, Windows WSL2 |

### 13.2 Açık Kararlar (Daha Sonra Verilecek)

- Anonymous telemetry koyalım mı? (opt-in)
- Discord mu Matrix mi community için?
- Logo / brand identity
- Yazı içeriği (blog/devlog) ne sıklıkla?

---

## 14. Başarı Kriterleri

Hangi sayılar görülünce "ürün çalışıyor" diyebiliriz (v0.1 release'den
sonra ölçülecek):

- **100+ GitHub star** (organic, paid push yok)
- **10+ gerçek kullanıcı** (issue açan, feedback veren)
- **3+ external contributor** (PR atan)
- **1+ blog post veya video** (kullanıcı tarafından yazılmış)

Bunlardan ikisi tutarsa devam, değilse pivot.

---

## 15. Son Söz

Bu proje **küçük başlıyor ama doğru yere bakıyor**:

- Agent ekosistemi patlıyor → çok agent'lı kullanıcılar artıyor.
- Güvenlik ve denetim katmanı yok → endişe büyüyecek.
- MCP standardı yerleşti → entegrasyon kolay.
- Local-first felsefe → mahremiyet duyarlı kullanıcı tabanına hitap.

OpenClaw nasıl "mesajlaşma kanalına AI getir" hamlesi yaptıysa, Foreman
"agent'larının önüne kontrol katmanı koy" hamlesi yapıyor. Aynı strateji
DNA'sı, farklı yüzey.

Şimdi sıra: repo aç, README yaz, kod başla.

---

*Son güncelleme: bu konuşma. Sürüm hedefi: v0.1.0.*
