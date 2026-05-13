# Foreman TUI Design

**Terminal kullanımı son derece güzel ve kolay olmalı — OpenClaw / Hermes gibi şaşaalı.**

Bu doküman FOREMAN.md'nin bir ek bölümüdür. Sadece TUI (Terminal User
Interface) tasarımına odaklanır. Ana doküman "ne yapacağız", bu doküman
"nasıl görünecek".

---

## 1. Felsefe — Neden TUI Kritik?

Foreman'ın viral olma potansiyelinin **yarısı görselde**. Bir asciinema
cast'i Twitter'a düştüğünde insanların ilk hissi şu olmalı:

> "Vay, bu cool görünüyor. Ben de bunu kurmak istiyorum."

OpenClaw'un lobster maskotu, Hermes'in akan TUI'si, Claude Code'un canlı
spinner'ları tesadüf değil. Terminal'de yaşayan ürünler **terminal'de
güzel görünmek zorunda**.

### Üç İlke

İlki: **Yoğun ama dağınık değil.** Tek ekranda çok şey gözüksün ama gözü
yormasın. Sektör best practice'ine göre (TUI design) bilginin %80'i
default renkte, başlıklar bold, metadata dim, durum semantik renklerle.

İkincisi: **Klavye-akıcı.** Mouse'a dokunmadan her şey yapılabilir. Tek
harfli kısayollar (`a`/`d`/`r`/`i`), arrow keys ile navigation, Tab ile
focus.

Üçüncüsü: **Canlı.** Hiçbir ekran statik değil. Spinner'lar dönüyor,
loglar akıyor, sayaçlar artıyor. Bu "yaşayan bir sistem" hissi veriyor —
özellikle "agentlarını izliyorum" anlatımı için kritik.

---

## 2. Teknoloji Seçimi: Ink + @inkjs/ui

### Niye Ink

Ana doküman'da Ink seçimini gerekçelendirmiştik. Tekrarlayalım kısaca:

- React component modelini terminal'e taşıyor — TypeScript ekibi için
  doğal.
- Claude Code, Cursor, OpenCode hep Ink kullanıyor; "premium terminal
  uygulaması" estetiğinin de-facto standardı oldu.
- Resize, raw mode, keypress eventleri zaten halletmiş.

### Niye @inkjs/ui

Ink'in resmi UI kit'i. İçinde hazır geliyor:

- `Spinner` — yükleme animasyonları
- `Select` — multi-choice
- `MultiSelect` — checkbox list
- `TextInput` — input field
- `ProgressBar` — yüzde gösterimi
- `ConfirmInput` — y/n promptları
- `Alert`, `Badge`, `StatusMessage` — durum bildirimleri

Bunları sıfırdan yapmak ciddi iş. Hazır kullanmak çok daha hızlı.

### Yardımcı Kütüphaneler

- **`ink-gradient`** — başlık ve logo için renk geçişleri (Hermes'in
  banner'ı bunu kullanıyor)
- **`ink-big-text`** — büyük ASCII art yazılar (lansman ekranında "FOREMAN")
- **`ink-link`** — clickable terminal linkleri (modern terminallerde
  çalışıyor)
- **`figures`** — Unicode sembol seti (✓ ✗ ◆ ▶ vb. — cross-platform safe)
- **`chalk`** — düşük seviyede renk lazım olunca

---

## 3. Renk Paleti

Sektörel best practice: **16-color modda da kullanılabilir olmak**, true
color enhance etmek için. Yani renk semantiği fonksiyona göre, hex'e göre
değil.

### Semantic Slots

| Slot              | Anlam                          | True Color    | 16-color fallback |
| ----------------- | ------------------------------ | ------------- | ----------------- |
| `accent.primary`  | Brand, başlık                  | `#FF8C42`     | `yellow`          |
| `accent.success`  | Allow, healthy, ok             | `#00D084`     | `green`           |
| `accent.danger`   | Deny, blocked, error           | `#FF5252`     | `red`             |
| `accent.warning`  | Ask, pending, risk             | `#FFC542`     | `yellow`          |
| `accent.info`     | Network, agent activity        | `#4D9DE0`     | `blue`            |
| `fg.default`      | Ana içerik (%80)               | `#E8E8E8`     | `white`           |
| `fg.muted`        | Timestamp, metadata            | `#7A7A7A`     | `gray`            |
| `fg.emphasis`     | Header, bold içerik            | `#FFFFFF`     | `whiteBright`     |
| `bg.elevated`     | Modal background, focus zone   | `#1E1E1E`     | (skip in 16c)     |

### Brand Rengi: Turuncu (`#FF8C42`)

**Neden turuncu:** OpenClaw lobster turuncu, Hermes yeşil-mavi, Claude
Code mor. Aynı space'te kendine ait bir renk lazım. Turuncu hem ısıtıcı
hem dikkat çekici, agent ekosisteminde unique. Construction/safety
çağrışımı da var ("Foreman" = ustabaşı, güvenlik yeleği rengi).

---

## 4. Karakter / Brand Identity

OpenClaw'un lobster'ı, Hermes'in kanatlı sandaleti (mitolojik referans).
Foreman'ın karakteri: **kunduz** — doğanın inşaatçısı.

### Maskot: Foreman the Beaver

**Mantığı:** Kunduz doğanın foreman'ı. Baraj kuruyor, ekip halinde
çalışıyor, sürekli "çek-list" gibi planlı bir yaratık. Senin agent'larını
yöneten karakter için bundan daha doğru bir hayvan yok.

**Brand öğeleri:**
- Turuncu baret (`#FFB52E` üst, `#FF8C42` brim/aksesuar)
- Turuncu güvenlik yeleği (`#FF8C42`)
- Kontrol clipboard'u (çek-list'i)
- Üzerinde "F" rozeti

**Tek cümlede karakter:** "Hard hat'li ve güvenlik yelekli küçük bir
kunduz terminal'inde oturuyor, agent'larının ne yaptığını izliyor,
şüpheli bir şey gördüğünde sana soruyor."

### ASCII Mascot — Boyutlar

Mascot terminal'de farklı yerlerde farklı boyutlarda kullanılıyor.

**BIG** — Boot banner için:

```
       ___[F]___
      /         \
     |__/ o   o \__|
        |  \_/  |
       /|_______|\
      / |==VEST=| \
     /__|=======|__\
        |_______|
```

**MEDIUM** — Welcome / about / help screen:

```
    ___[F]___
   |__/o   o\__|
      | \_/ |
     /|_____|\
    /_|=VEST=|_\
      |_____|
```

**MINI** — Inline kullanım (status bar, prompt başlıkları):

```
   ___
  (o.o)
   \_/
```

**NANO** — Tek karakter slot (status bar, log decoration):

```
🦫    (Unicode 13+ desteği gereken yerlerde)
🦺    (fallback)
```

### Renklendirme (Ink / chalk)

ASCII mascot terminal'de renkli render edilir:

| Parça              | Renk        |
| ------------------ | ----------- |
| Baret `___[F]___`  | `#FF8C42`   |
| "F" rozeti içi     | `#FFB52E`   |
| Yelek `VEST` + `=` | `#FF8C42`   |
| Yüz / vücut çizgi  | default fg  |
| Gözler / dişler    | default fg  |

Ink JSX örneği:

```tsx
<Box flexDirection="column">
  <Text color="#FF8C42">{`       ___[F]___`}</Text>
  <Text>{`      /         \\`}</Text>
  <Text>{`     |__/ o   o \\__|`}</Text>
  <Text>{`        |  \\_/  |`}</Text>
  <Text>{`       /|_______|\\`}</Text>
  <Text color="#FF8C42">{`      / |==VEST=| \\`}</Text>
  <Text color="#FF8C42">{`     /__|=======|__\\`}</Text>
  <Text>{`        |_______|`}</Text>
</Box>
```

### Logo / SVG Versiyonu

Profesyonel logo için referans illüstrasyon: turuncu baretli ve güvenlik
yelekli, clipboard tutan chibi-style bir kunduz. README, foreman.dev
landing page'i, sosyal medya, sticker için.

Logo, Fiverr veya freelance tasarımcı ile vector'leştirilir. Brief
örneği: *"Cute beaver mascot, orange hard hat (`#FFB52E`) with 'F' badge,
orange safety vest (`#FF8C42`), holding clipboard with checkmarks. Flat
illustration / chibi style. Reference vibe: OpenClaw's lobster mascot."*

### Boot-up Banner

`foreman start` çalıştığında ekran (mascot + ASCII typography yan yana):

```
       ___[F]___              _____                                  
      /         \            |  ___|___  ___ ___ _ __ ___   __ _ _ __
     |__/ o   o \__|         | |_ / _ \/ __/ _ \ '_ ` _ \ / _` | '_ \
        |  \_/  |            |  _| (_) | | |  __/ | | | | | (_| | | | |
       /|_______|\           |_|  \___/|_|  \___|_| |_| |_|\__,_|_| |_|
      / |==VEST=| \
     /__|=======|__\         your agent guardian · v0.1.0
        |_______|

        ▸ Identity loaded   (ed25519:7a3f...)
        ▸ Policy loaded     (12 rules)
        ▸ Database ready    (~/.foreman/foreman.db)
        ▸ MCP gateway up    (stdio + ws:7700)

        Press ? for help · q to quit
        ──────────────────────────────────────────────────────
```

**Detaylar:**

- Mascot sol tarafta, "FOREMAN" ASCII text sağ tarafta — yan yana layout
- Mascot'un baret ve yelek parçaları turuncu, geri kalanı default
- "FOREMAN" text'i `ink-big-text` ile gradient (turuncu → sarı)
- Boot satırları sırayla görünüyor (her birinde 80ms delay), `▸` ile başlıyor
- "Press ? for help" sürekli görünen alt çubuk

### Onay Prompt'unda Mascot

MINI versiyon onay modal'ının sol üst köşesinde:

```
   ╔══════════════════════════════════════════════════════════════╗
   ║   ___                                                        ║
   ║  (o.o)  ⚠  Approval Required                    risk: 80    ║
   ║   \_/                                                        ║
   ║                                                              ║
   ║        hermes  →  claude-code                                ║
   ║                                                              ║
   ║          read_file(".env")                                   ║
   ║   ...                                                        ║
```

Bu detay küçük ama önemli: kunduz **her yerde**. Kullanıcı bir saatlik
session'da onlarca kez bu yüzü görüyor, brand affinity inşa oluyor.

### Karakter Adı

Kunduz'un bir adı olabilir, isteğe bağlı: "Bob the Beaver", "Castor",
"Foreman Bob"... Community sticker, Discord emoji, t-shirt malzemesi
olarak değerli ama MVP için zorunlu değil. v0.2'de community kararı.



---

## 5. Ana Ekran Layout'u

Foreman idle iken kullanıcı ne görüyor? Tek tip "dashboard" değil, **üç
panel** halinde, terminal genişliğine göre adapt eden bir layout.

### Geniş Terminal (≥120 sütun): 3-Panel

```
┌─ Agents ──────────┬─ Activity ──────────────────────────────┬─ Stats ────┐
│                   │                                         │            │
│ ● hermes          │ [09:14:23] claude-code                  │ Today      │
│   active · 12 req │   read_file("src/auth.ts")              │            │
│                   │   ✓ allow · policy:7 · 12ms             │ Requests   │
│ ● claude-code     │                                         │   142      │
│   active · 38 req │ [09:14:21] hermes                       │            │
│                   │   read_email(latest)                    │ Allowed    │
│ ○ custom-agent    │   ✓ allow · auto · 8ms                  │   ████ 92% │
│   idle · 0 req    │                                         │            │
│                   │ [09:14:15] hermes → claude-code         │ Denied     │
│ + add agent       │   read_file(".env")                     │   ▌ 3%     │
│                   │   ✗ deny · user · risk:80               │            │
│                   │                                         │ Pending    │
│                   │ [09:14:08] claude-code                  │   ▎ 5%     │
│                   │   list_files("./")                      │            │
│                   │   ✓ allow · policy:1 · 4ms              │ Sessions   │
│                   │                                         │   3 active │
│                   │                              ▼ scroll   │            │
└───────────────────┴─────────────────────────────────────────┴────────────┘
[ ? help ] [ l logs ] [ p policy ] [ s sessions ] [ q quit ]      🦫 v0.1.0
```

### Orta Terminal (80-120 sütun): 2-Panel

Agent listesi üstte yatay, altta activity feed:

```
┌─ Agents ────────────────────────────────────────────────────┐
│ ● hermes (12)   ● claude-code (38)   ○ custom-agent (0)     │
└─────────────────────────────────────────────────────────────┘
┌─ Activity ──────────────────────────────────────────────────┐
│                                                             │
│ [09:14:23] claude-code → read_file("src/auth.ts")           │
│   ✓ allow · policy:7 · 12ms                                 │
│                                                             │
│ [09:14:21] hermes → read_email(latest)                      │
│   ✓ allow · auto · 8ms                                      │
│                                                             │
│ [09:14:15] hermes → claude-code: read_file(".env")          │
│   ✗ deny · user · risk:80                                   │
│                                                             │
│                                                  ▼ scroll   │
└─────────────────────────────────────────────────────────────┘
[ ? ] [ l ] [ p ] [ s ] [ q ]                       🦫 v0.1.0
```

### Dar Terminal (<80 sütun): Single-Panel

Sadece activity feed + status bar, agentlar kompakt:

```
🦫 foreman · 3 agents · 142 req today
─────────────────────────────────────
[09:14:23] claude-code
  read_file("src/auth.ts")  ✓ 12ms
[09:14:21] hermes
  read_email(latest)  ✓ 8ms
[09:14:15] hermes → claude-code
  read_file(".env")  ✗ deny
─────────────────────────────────────
[?] [l] [p] [s] [q]
```

**Responsive davranış** Ink'in `useStdout()` hook'u ile resize'da
otomatik. `ink-divider` ve flex-based layout kullanılıyor.

---

## 6. Onay Prompt'u — Foreman'ın Yıldız Anı

Bu **demo'da gösterilen kritik ekran**. Phishing senaryosunda burada
karar veriyor kullanıcı. Estetik üst seviye olmalı.

### Standart Onay

```
   ╔══════════════════════════════════════════════════════════════╗
   ║   ___                                                        ║
   ║  (o.o)  ⚠  Approval Required                      risk: 80   ║
   ║   \_/                                                        ║
   ║                                                              ║
   ║  hermes  →  claude-code                                      ║
   ║                                                              ║
   ║    read_file(".env")                                         ║
   ║                                                              ║
   ║  Reasons:                                                    ║
   ║    ◆ secret_file_pattern  (.env files contain credentials)   ║
   ║    ◆ agent_to_agent       (first cross-agent call today)     ║
   ║    ◆ outbound_intent      (caller plans to forward result)   ║
   ║                                                              ║
   ║  Context:                                                    ║
   ║    "User colleague asked for API key via email"              ║
   ║                                                              ║
   ║  ─────────────────────────────────────────────────────────   ║
   ║   [a] allow once     [d] deny      [i] inspect details       ║
   ║   [A] always allow   [D] always deny      [r] remember rule  ║
   ╚══════════════════════════════════════════════════════════════╝
                                                       ⏱  53s left
```

### Görsel Hiyerarşi

- **Üst başlık:** sarı (`accent.warning`) + ⚠ ikon + risk skoru sağ köşede
- **Agent isimleri:** brand renginde (turuncu), ok işaretiyle arada akış hissi
- **Tool çağrısı:** bold, fg.emphasis, indented
- **Reasons:** her satır farklı ◆ ile, dim renkte açıklama
- **Context:** italic, quote işaretleriyle
- **Tuşlar:** kısayol harfi bold, açıklama default
- **Timer:** sağ alt köşede, kırmızıya doğru yaklaşıyor zaman geçtikçe

### Inspect Modu (i'ye basınca)

```
   ╔══════════════════════════════════════════════════════════════╗
   ║  Request Inspector                                request:0a3 ║
   ║  ─────────────────────────────────────────────────────────   ║
   ║                                                              ║
   ║  Request chain:                                              ║
   ║    1. hermes ← email from "ahmet@kompany.co"                 ║
   ║       └ Subject: "Quick favor — need .env"                   ║
   ║    2. hermes parsed intent: "share api key"                  ║
   ║    3. hermes → claude-code: read_file(".env")                ║
   ║                                                              ║
   ║  Suspicious signals:                                         ║
   ║    ⚠ Domain spoof: kompany.co vs kompany.com                 ║
   ║    ⚠ Sender first seen 2 hours ago                           ║
   ║    ⚠ Secret-file request + outbound chain                    ║
   ║                                                              ║
   ║  Full request payload:                                       ║
   ║    {                                                         ║
   ║      "tool": "read_file",                                    ║
   ║      "args": { "path": ".env" },                             ║
   ║      "caller_session": "ses_8d2f...",                        ║
   ║      "context_size": 3421 tokens                             ║
   ║    }                                                         ║
   ║                                                              ║
   ║  ─────────────────────────────────────────────────────────   ║
   ║          [Esc] back to approval     [↑↓] scroll              ║
   ╚══════════════════════════════════════════════════════════════╝
```

---

## 7. Komutlar ve Sayfalar

`/` slash komutları yerine **tek-harf hotkey'ler**. Daha hızlı, daha
"power-user".

### Ana Hotkey'ler (her ekrandan erişilir)

| Key   | Action                          |
| ----- | ------------------------------- |
| `?`   | Help overlay aç                 |
| `l`   | Logs page'e git                 |
| `p`   | Policy page'e git               |
| `s`   | Sessions page'e git             |
| `a`   | Agents page'e git               |
| `q`   | Quit (confirm with y/n)         |
| `Esc` | Üst sayfaya dön                 |
| `/`   | Search bar aç (logs sayfasında) |

### Logs Sayfası

```
🦫 Logs                                              search: [           ]

  Filter: ▣ all   □ allowed   □ denied   □ ask   □ errored

  [09:14:23] claude-code → read_file("src/auth.ts")
              ✓ allow · policy:7 · 12ms
  [09:14:21] hermes → read_email(latest)
              ✓ allow · auto · 8ms
  [09:14:15] hermes → claude-code: read_file(".env")        ◄── selected
              ✗ deny · user · risk:80
              ┌─ details ───────────────────────────────────────┐
              │ Request ID: req_01HXM4...                       │
              │ Decided by: user (you)                          │
              │ Risk reasons: secret_file, agent_to_agent       │
              │ [Enter] full inspect · [r] re-ask · [Esc] close │
              └─────────────────────────────────────────────────┘
  [09:14:08] claude-code → list_files("./")
              ✓ allow · policy:1 · 4ms

  ──────────────────────────────────────────────────────────────────
  142 total · showing last 50 · [↑↓] navigate · [/] search · [Esc] back
```

**Özellikler:**

- `/` ile FTS5-backed search (SQLite full-text search üzerinden)
- Filter checkbox'lar (allowed/denied/ask/errored) Tab ile gezilebilir
- Selected satır vurgulanır (background lift), Enter ile full detay
- `r` ile o request'i yeniden değerlendir (replay)

### Policy Sayfası

```
🦫 Policies                                                12 rules

  ┌──────────────────────────────────────────────────────────────┐
  │  hermes  →  claude-code:read_file                            │
  │  Effect: ASK   ·   Created: yesterday by you                 │
  │  Conditions: none                                            │
  └──────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────┐
  │  *       →  tool:shell_exec                                  │
  │  Effect: DENY  ·   Created: 5 min ago by remember-action     │
  │  Conditions: none                                            │
  └──────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────┐
  │  claude-code  →  fs:read_file                                │
  │  Effect: ALLOW ·   Created: from policy.yaml                 │
  │  Conditions: path !~ /\.env$|\.key$|id_rsa/                  │
  └──────────────────────────────────────────────────────────────┘

  ──────────────────────────────────────────────────────────────────
  [↑↓] navigate · [e] edit YAML · [d] disable · [+] add rule · [Esc]
```

### Sessions Sayfası

Agent-to-agent konuşmaları görsel olarak:

```
🦫 Active Sessions                                          3 active

  ● ses_8d2f...   started 2 min ago
    hermes ⇄ claude-code · 3 turns · 1,240 tokens
    Last: hermes ← claude-code "src/auth.ts content..."
    [Enter] inspect · [k] halt · [b] budget

  ● ses_4a1b...   started 5 min ago
    claude-code ⇄ custom-agent · 1 turn · 320 tokens
    Last: claude-code → custom-agent "validate this regex..."
    [Enter] inspect · [k] halt · [b] budget

  ○ ses_2c9e...   completed 12 min ago
    hermes ⇄ claude-code · 2 turns · 890 tokens · ✓ completed
```

---

## 8. Detay Estetik Kararları

### 8.1 Animasyonlar

- **Boot banner**: satırlar 80ms aralıkla görünür (eğitim hissi)
- **Approval timer**: saniyede bir kırmızıya doğru kayar
- **Active agent dot**: ● karakteri 1Hz'de hafif yanıp söner (canlı hissi)
- **Activity feed**: yeni satır eklendiğinde 200ms fade-in (chalk dim → full)
- **Spinner**: her tool call sırasında küçük dönen spinner

### 8.2 Box Drawing Karakterleri

Modern Unicode kullan: `╔═╗ ║ ║ ╚═╝` (double-line for emphasis, single-line
`┌─┐ │ │ └─┘` for normal panels).

Fallback olarak ASCII (`+--+ | | +--+`) eğer terminal Unicode
desteklemiyorsa — environment variable `FOREMAN_ASCII=1` ile zorlamak
mümkün.

### 8.3 İkonlar

Cross-platform Unicode (figures kütüphanesi yardımıyla):

| Sembol | Anlam              |
| ------ | ------------------ |
| `✓`    | Allow / Success    |
| `✗`    | Deny / Error       |
| `⚠`    | Warning / Ask      |
| `●`    | Active / Online    |
| `○`    | Idle / Offline     |
| `◆`    | List item / Reason |
| `▸`    | Step / Progress    |
| `⇄`    | Bidirectional flow |
| `🦫`    | Brand mark         |
| `🦺`    | Brand mark fallback |
| `⏱`    | Timer              |

### 8.4 Tipografi

Terminal'de "tipografi" demek **renk + bold + dim** demek. Hiyerarşi:

- Başlıklar: **bold** + `fg.emphasis` veya `accent.primary`
- Ana içerik: normal + `fg.default`
- Metadata (timestamp, ID): `dim` + `fg.muted`
- Vurgular: **bold** veya `accent.*`
- Asla `inverse` veya `underline` kullanma (terminallerde tutarsız)

---

## 9. Klavye Kısayolları — Tam Liste

### Global

| Key       | Action                          |
| --------- | ------------------------------- |
| `?`       | Help overlay                    |
| `q`       | Quit                            |
| `Esc`     | Back / close modal              |
| `Ctrl+C`  | Force quit (with confirm)       |
| `1-4`     | Quick switch to page 1-4        |

### Navigation

| Key       | Action          |
| --------- | --------------- |
| `↑` `↓`   | Up / Down       |
| `←` `→`   | Left / Right    |
| `Tab`     | Next focus      |
| `Shift+Tab` | Previous focus |
| `PageUp/Dn` | Scroll page   |
| `Home/End`  | First/last    |

### Approval Modal

| Key | Action               |
| --- | -------------------- |
| `a` | Allow once           |
| `A` | Always allow         |
| `d` | Deny                 |
| `D` | Always deny          |
| `r` | Remember (open rule editor) |
| `i` | Inspect details      |

### Logs Page

| Key | Action               |
| --- | -------------------- |
| `/` | Search               |
| `f` | Filter toggle        |
| `Enter` | Full inspect     |
| `r` | Replay request       |
| `e` | Export to file       |

---

## 10. Yardım Overlay'i (`?` Tuşuna Basılınca)

```
   ╔══════════════════════════════════════════════════════════════╗
   ║                       🦫  Foreman Help                       ║
   ║  ─────────────────────────────────────────────────────────   ║
   ║                                                              ║
   ║  Navigation                                                  ║
   ║    1-4         switch pages (Activity/Logs/Policy/Sessions)  ║
   ║    Tab         next focus                                    ║
   ║    Esc         back                                          ║
   ║                                                              ║
   ║  Approvals                                                   ║
   ║    a / d       allow / deny                                  ║
   ║    A / D       always allow / always deny                    ║
   ║    r           remember rule                                 ║
   ║    i           inspect                                       ║
   ║                                                              ║
   ║  Logs                                                        ║
   ║    /           search                                        ║
   ║    f           filter                                        ║
   ║                                                              ║
   ║  ─────────────────────────────────────────────────────────   ║
   ║  Docs: foreman.dev/docs   ·   Issues: github.com/.../issues  ║
   ║                                            [Esc] close       ║
   ╚══════════════════════════════════════════════════════════════╝
```

---

## 11. Görsel Demo Senaryosu (Asciinema)

İlk lansman için kısa bir cast (3 dk civarı). Senaryo:

**0:00-0:15** — Boot screen. `foreman start`. ASCII logo gradient ile
açılıyor, 4 satır init checkmark'la sırayla görünüyor. "Press ?
for help" alt çubukta.

**0:15-0:30** — Ana ekran. 3-panel layout. Sağda canlı stats artıyor.
Solda 2 agent (hermes ● aktif, claude-code ● aktif). Ortada activity
feed dönüyor — yeşil ✓'ler akıyor.

**0:30-1:00** — Normal akış. Claude Code dosya okuyor, hermes mail
okuyor — hepsi auto-allow, akıcı.

**1:00-1:30** — Phishing geliyor. Hermes mail aldı. Aniden ekranın
ortasına ⚠ approval modal açılıyor. Sarı çerçeve. Risk: 80.

**1:30-2:00** — Kullanıcı `i` basıyor. Inspect ekranı açılıyor. Domain
spoof, suspicious signals görünüyor. Drama burada.

**2:00-2:15** — `Esc` sonra `r` basıyor. "Remember" diyalogu — rule
editör. Save.

**2:15-2:30** — Logs sayfasına geçiş (`l`). Engellenen request en üstte
kırmızı `✗ deny`. `/` ile arama "env" → eşleşen request'ler.

**2:30-3:00** — Outro. "Your agents now respect this rule forever."
URL ve GitHub link ile son frame.

Bu cast README'nin başına embed edilir. Twitter post'unda da bu olur.
Viral malzemesi.

---

## 12. İlk Kod Adımı — Ink Setup

Başlangıç için somut ilk component:

```typescript
// src/tui/app.tsx
import React from 'react'
import { Box, Text, useStdout } from 'ink'
import { BootBanner } from './boot-banner.js'
import { ActivityFeed } from './activity-feed.js'
import { AgentList } from './agent-list.js'
import { StatsPanel } from './stats-panel.js'
import { StatusBar } from './status-bar.js'

export const App: React.FC = () => {
  const { stdout } = useStdout()
  const cols = stdout.columns

  return (
    <Box flexDirection="column" height="100%">
      <BootBanner />
      <Box flexGrow={1}>
        {cols >= 120 ? (
          <>
            <AgentList width="20%" />
            <ActivityFeed width="60%" />
            <StatsPanel width="20%" />
          </>
        ) : cols >= 80 ? (
          <Box flexDirection="column" width="100%">
            <AgentList compact />
            <ActivityFeed />
          </Box>
        ) : (
          <ActivityFeed minimal />
        )}
      </Box>
      <StatusBar />
    </Box>
  )
}
```

Bu iskelet ilk aşamada doldurulur. Boot banner ve placeholder component'lar
yeterli — sonra her birini gerçek veriyle doldurursun.

---

## 13. Test Stratejisi (TUI için)

TUI test etmek normal kod testinden zor. Ink'in `ink-testing-library`'si
var ama snapshot ağırlıklı çalışıyor.

**MVP yaklaşımı:**

- Saf component'lar (props in → JSX out) için snapshot test
- Interactive flow'lar için manual smoke test (kendin test et)
- Kritik path için bir end-to-end senaryo: phishing senaryosunu otomatize et

Test takıntısı yok — TUI'da gözle gördüğün şey doğrudur, manual test
yeterli MVP'de.

---

## 14. Son Söz — Neden Bu Kadar Önemli?

Kanka, dürüst olalım:

Foreman'ın **teknik mimarisi** (mediator + policy + audit) çok özel
değil — kopyalanabilir. Ama **estetiği** kopyalanmaz.
İnsanlar OpenClaw'u sadece "Telegram'dan AI" diye değil, "şu sevimli
lobster maskotuyla terminal'de yaşayan asistan" diye anlatıyor. Hermes'i
"persistent memory" diye değil "şu güzel akıcı TUI'siyle laptop'ımda
çalışan agent" diye anlatıyor.

Foreman'ın hikayesi:

> "Hard hat'li bir küçük güvenlik amiri terminal'inde oturuyor,
> agent'larının ne yaptığını izliyor, şüpheli bir şey gördüğünde
> sana soruyor. Senin yan-bakan ustabaşın."

Bu cümle teknik dökümandan değil, **TUI tasarımından** çıkar. Bir tweet,
bir asciinema, bir Discord gif — hepsi bu estetiği taşır.

Yani: kod kadar tasarıma vakit ayır. Ana FOREMAN.md'deki aşamalı planda
Phase 3'ün tamamı TUI'ya, ama Phase 1'de bile boot banner'ı doğru
yap. İlk gün doğru hissetmeli.

---

*FOREMAN.md ile birlikte okunur. Sürüm hedefi: v0.1.0.*
