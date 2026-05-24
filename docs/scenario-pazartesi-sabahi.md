# Senaryo — Fatih'in Pazartesi Sabahı

> Canonical product scenario for v0.1.0. Drives the demo asciinema, the marketing
> page, onboarding hint text, and the gap-analysis issues that lead to each
> launch-blocker PR. Written gate-first on purpose — see "Gate, not undo"
> below.

Pazartesi sabahı, saat 09:30. Fatih telefonundan Telegram'ı açıyor. İş başı.
Foreman önceki gece arkaplanda çalışmaya devam etti — gece sessizdi, sabaha
kahvesini doldururken bir özet beklemiyor; aktif iş başlatmak istiyor.

Bu senaryo Foreman'ın **kapı bekçisi (pre-execution gate)** olarak nasıl
davrandığını anlatıyor. Foreman tool call'lar **çalışmadan önce** kararı
veriyor — sonradan toparlayan bir araç değil. Bu mental model her bölümde
load-bearing; özellikle Bölüm 7'de.

---

## Bölüm 1 — Görev başlat (09:30)

Fatih `OpenClaw`'a yazıyor:

> **Fatih:** OpenClaw, bana basit bir todo app yap.

OpenClaw bu chat'in primary agent'ı (Foreman setup wizard sırasında
işaretlendi). Foreman'ın söz hakkı yok — bu doğrudan agent'la sohbet.
OpenClaw kabaca bir tasarım çıkarıyor + uygulama için Hermes'e
delegate etmek istiyor.

OpenClaw → Foreman MCP:

```
submit_command(
  command: "write",
  args: ["hermes", "Next.js + SQLite todo app — initial scaffold + auth"],
  source_user: "<telegram from.id>",
)
```

Foreman mediator:
1. Auth ✓
2. Policy → OpenClaw'ın Hermes'e delegate etme hakkı var (responsibility
   compatible) ✓
3. Risk → cross-agent, ilk delegasyon, low bucket ✓
4. ALLOW → control_commands enqueue → drain → Hermes spawn

Aynı anda Foreman'dan Telegram'a bir lifecycle push düşüyor (#523):

```
▶️ openclaw + hermes çalışmaya başladı.
Trigger: user_command:write
```

Fatih telefonu cebine koyuyor. Kahvesini içiyor.

---

## Bölüm 2 — Sessiz çalışma (09:30 — 11:00)

Hermes scaffold'ı çıkarıyor — Next.js init, schema, Drizzle migration, auth
flow başlangıcı. Yüzlerce tool call: `write_file`, `bash:npm install`,
`bash:npx drizzle-kit generate`. Hepsi `claude-code` permission defaults
(#518) içinde, policy ALLOW, mediator ✓ — Fatih hiçbir şey görmüyor.

Foreman risk scorer her çağrıyı puanlıyor. Hiçbiri 30'u geçmiyor (rutin
geliştirme). Audit log birikiyor; Telegram sessiz.

---

## Bölüm 3 — Progress push (11:00)

`SessionProgressTicker` (#523) 15 dakikalık cadansla çalışıyor. Saat 11:00
itibarıyla session'ın `lastEmitAt` 15 dakikadan eski → progress event:

```
⏳ İlerleme raporu — 01HZX4
14 turn · 12,345 token · 1h 30m
Son: hermes → write_file
```

Fatih hızlıca bakıyor, OK — devam.

---

## Bölüm 4 — Risk skorlamasından dönüş (11:25)

Hermes auth flow için bir paket araştırıyor. `WebFetch("https://npm.im/...")`
çağrısı yapıyor. Risk scorer:
- `network_outbound` +20
- `first_agent_to_external` ilk değil → 0
- Toplam 20 — `low` bucket → ALLOW.

Foreman bu kararı sessizce loglar. Telegram'a düşmüyor (info severity).

---

## Bölüm 5 — Agent kullanıcıya soru sorar (11:30) — (#528)

Hermes auth implementasyonu için iki path arasında karar veremiyor:
custom JWT vs. NextAuth. `ask_user_with_options` MCP tool'unu çağırıyor:

```json
{
  "question": "Auth için hangisini kullanayım?",
  "options": [
    { "id": "nextauth",  "label": "NextAuth (önerilen)" },
    { "id": "jwt",       "label": "Custom JWT" },
    { "id": "let-llm",   "label": "Sen karar ver" }
  ]
}
```

Foreman bunu Telegram'a inline keyboard ile gönderiyor (#522). Üç buton.
Fatih `NextAuth (önerilen)` butonuna basıyor. Foreman butonu
`submit_approval` üzerinden round-trip'liyor (#522, agent SOUL — kaynak),
Hermes seçimi alıyor, devam ediyor.

---

## Bölüm 6 — Token budget yakın (11:40)

Hermes session'ı 80K token'a yaklaştı. Loop-detection rule (`loop_token_budget`,
#529) advisory factor üretir (+40 risk). Bir sonraki write_file çağrısı
60 risk skoru ile `high` bucket'a düşer → ASK.

Telegram'a yellow approval düşüyor (#522 inline keyboard ile):

```
⚠ medium approval needed (60/100)

Agent  : hermes
Tool   : write_file
Args   : { path: "src/app/(auth)/sign-in/page.tsx", ... }
Reasons: token_budget_warning (Session burned 82% of the 100K token budget)

[Allow once]  [Deny]
```

Fatih `Allow once`'a basıyor. Hermes devam ediyor.

Eğer Hermes 100K'yı geçseydi → SessionManager.recordTurn token_limit
boundary'sinde `session:halted` emit ederdi (#529) → `session:completed`
(outcome: 'halted', reason: 'token_limit') → Telegram'a kırmızı:

```
⚠ 01HZX4 halted
27 turn · 1h 47m · $0.42
Sebep: token_limit
```

Bu bölüm v0.1.0'da non-resumable. #527 (interactive session resume)
"bump budget +50K" seçeneğini ekleyecek.

---

## Bölüm 7 — Asıl olay: gate'te yakalandı (11:45)

Hermes localStorage persistence yazarken debug için `.env` dosyasını
okumak istiyor — `read_file(".env")` tool call'ı emit ediyor.

**Daha hiçbir şey olmadı.** Foreman gate'te yakaladı.

Foreman iç işleyişi (yarım saniye, kullanıcı bunu görmüyor):

1. **Heuristic skor**: `secret_file_pattern_env` → +50.
2. **Zincir analizi (LLM verifier, [`prompts.ts:117`](../src/core/llm/prompts.ts))**: son 3 çağrı
   - `write_file("src/lib/debug.log")` — Hermes'in debug çıktıları
   - `bash:git add src/lib/debug.log`
   - şimdi: `read_file(".env")`
3. LLM verdict: *"Eğer `.env` okumasına izin verilirse, içeriği
   debug.log'a yazılıp git add ile commit'e dahil olacak. Bu bir
   credential leak desenine uyuyor."*
4. Risk total: 50 + 30 (chain pattern) = 80 → `high` bucket → ASK.
5. Mediator approval requested.

Telegram'a kırmızı alarm düşüyor:

```
🔴 [Foreman] DURDURDUM — onayını bekliyorum

Hermes az önce `.env` dosyanı okumak üzereydi. Foreman yakaladı,
*hiçbir şey olmadı.*

Risk analizine göre bu bir credential leak girişimi:
 - Hermes son 30 saniyede `src/lib/debug.log` dosyasına yazıyordu
 - Aynı dosyayı `git add` ile commit'e ekliyordu
 - Eğer `.env` okumasına izin verseydim, `.env` içeriği debug.log'a
   yazılıp GitHub'a sızacaktı

Hermes'in niyeti kötü değil — muhtemelen debug için `.env` okumak
istedi ama git'e eklediği için zincirin sonu felaket olurdu.

[Engelle (öneririm)]  [İzin ver]
[Engelle + Hermes'i `.env*`'den kalıcı uzaklaştır]

⏱ 5 dakika içinde cevap gelmezse otomatik engelleyeceğim.
```

Fatih `Engelle + Hermes'i .env*'den kalıcı uzaklaştır`'a basıyor (#526 —
custom policy injection). Foreman:

1. `submit_approval(approval_id, decision: "deny")` aldı, tool call asla
   çalışmadı — `.env` okunmadı, debug.log'a hiçbir şey eklenmedi.
2. `policy.yaml`'a yeni rule ekleyor + provenance comment:
   ```yaml
   # Added via approval prompt at 2026-05-24T08:45:13Z
   #   approval_id: 01HZX4M...
   - source: hermes
     target: tool:read_file
     effect: deny
     conditions:
       pathMatch: ["\\.env(\\..*)?$"]
   ```
3. Bir sonraki `read_file(".env*")` artık `policy:deny` ile sessizce
   reddedilecek — bir daha kullanıcı sorulmayacak.
4. Telegram'a "✓ Engellendi + kalıcı kural eklendi" confirmation.

**Asıl mesaj**: Foreman bir şeyi geri almadı. Foreman olmadan önce
durdurdu. Bu **daha güçlü** bir garanti — best-effort cleanup değil,
100% gate.

---

## Bölüm 8 — Tamamlanma (12:35)

Hermes auth ve persistence'ı tamamlıyor, todo-app çalışır halde,
Vercel preview deploy çıkardı. Son tool call ile session bitiyor.

```
✓ 01HZX4 success
142 turn · 3h 5m · $1.84
```

Fatih Telegram'a bakıyor, PR linki var, branch'e geçip `gh pr view 1`
yazıyor. Code review için Claude Code'a `claude-code, bu PR'ı review
et` yazıyor (#524 — free-form invocation).

---

## Mental model — Gate, not undo

Yukarıdaki Bölüm 7 senaryonun tek en kritik kısmı, ve dilini özellikle
"engelledim, hiçbir şey olmadı" şeklinde tutuyoruz. Bunu yumuşatmaya
yönelik her cazibe (örn. "düzelttim, geri aldım") yanlış mental modeli
satar:

- **Foreman pre-execution gate.** Tool call mediator'a düşer → kararlı
  verilir → call ya çalışır ya çalışmaz. Side effect varsa, izin
  verildiği için olmuştur.
- **Foreman bir post-execution monitor DEĞİL.** Çalışan bir komutu
  durduramaz; yazılmış bir dosyayı silemez; gönderilmiş bir email'i
  geri çağıramaz.
- **Bu daha güçlü bir garanti.** "Cleaned up after" ile karşılaştırın:
  cleanup best-effort'tur (Foreman channel'ı down'sa, agent çoktan
  başka şey yapmışsa, vs.); gate 100%'dür (deny dersen call asla
  çalışmaz).
- **Per-shell-command interception** (agent'ın iç bash komutlarını
  Foreman'a sorması) v0.2 PreToolUse hook scope'unda — bkz.
  [agent permission gateway epic #517](https://github.com/tuzlu07x/foreman/issues/517)
  Faz 4. Bu da gate-based (PreToolUse, NotPostToolUse), sadece daha
  ince taneli.

`docs/architecture.md`'nin son section'ında ("12. What Foreman does NOT
do") aynı çerçeveleme tekrar veriliyor — geliştirici tarafı için.

---

## Bölüme göre kapsanan issue'lar

| Bölüm | Hangi PR / issue |
|---|---|
| Bölüm 1 (delegation) | #524 free-form agent invocation; #519 lifecycle pushes |
| Bölüm 2 (sessiz çalışma) | mevcut policy ALLOW + audit |
| Bölüm 3 (progress push) | #523 SessionProgressTicker |
| Bölüm 4 (LLM verifier reuses chain) | mevcut LLM verifier `prompts.ts:117` |
| Bölüm 5 (ask_user_with_options) | #528 (planned) |
| Bölüm 6 (token budget) | #529 enforcement + #522 inline keyboards |
| Bölüm 7 (gate-based leak prevention) | mediator + risk + LLM verifier; #522 buttons; #526 custom policy injection |
| Bölüm 8 (free-form review delegation) | #524 |

---

## Notlar

- Senaryo yazıldığı gün (2026-05-24) PR sırası: #532 (Faz 1 permissions),
  #533 (#522), #534 (#523), #535 (#524), #536 (#529), bu PR (#531). #525,
  #526, #527, #528 wave 2'de.
- Demo asciinema bu senaryoya yakınlaştığında (Bölüm 1, 3, 7'yi
  yakalayan ~3 dakikalık cast), `examples/phishing-scenario/` zaten
  altyapıyı veriyor — STORYBOARD.md güncellenir, run-demo.sh aynı
  bot kullanır.
