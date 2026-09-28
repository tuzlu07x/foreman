# Foreman: durum raporu ve yol haritası

_28 Eylül 2026 · main: `1e8bf53` (#661'in merge'ü) · npm'deki sürüm: `foreman-agent@0.1.6`_

Bu belge üç şeyi anlatır: Foreman'ın amacı, şimdiye kadar yapılanlar ve sıradaki işler. Yeni bir çalışma oturumu buradan devam edebilsin diye yazıldı. Oturumun başında önce bu dosyayı, sonra `AGENTS.md` ve `CONTRIBUTING.md` dosyalarını oku.

---

## 1. Amaç

**Foreman**, geliştiricilerin kullandığı AI agent'lar için yerel çalışan (local-first) bir güvenlik geçididir. Desteklenen agent'lar Claude Code, Codex, Hermes, OpenClaw, ZeroClaw ve genel MCP istemcileridir. Bir agent bir araç çağırmak istediğinde çağrı çalışmadan önce Foreman'dan geçer:

- **Politika:** izin ver, sor veya reddet.
- **Risk puanı:** sır sızıntısı, prompt injection, tehlikeli komut, döngü, rol ihlali gibi durumlar puanlanır.
- **Onay:** gerekirse TUI'den veya telefondan (Telegram, Slack, Discord) onay istenir.
- **Audit:** her şey yerel bir audit kaydına yazılır.

**v0.2 vizyonu:** "Agent'larını bir şirket gibi yönet."

- **Departmanlar ve hiyerarşi.** Finans, Pazarlama, IT gibi departmanlar kurulur, her birinin yöneticisi olur. Patron kullanıcının kendisidir; Foreman da tüm ekiplerin denetçisidir.
- **Her yerden yönetim.** Patron TUI'den veya Slack/Discord/Telegram'dan komut verir, onaylar ve rapor ister. Departman kanallarını görür; bütçe, token ve maliyet raporlarını alır.
- **Entegrasyonlar.** GitHub, GitLab, Jira, Trello, Linear ve Notion kurulumdan sonra da kolayca eklenir, açılıp kapatılır, güncellenir ve silinir. Bunlar TUI'den, CLI'dan ve chat'ten yapılabilir.
- **Popüler açık kaynak proje.** Hedef yıldız, fork ve dışarıdan gelen PR'lar. Bunun için temiz bir TUI, kolay kurulum, iyi dokümantasyon ve bir demo gerekiyor.

**Çalışma kuralları (kalıcı):**

- **Commit kimliği:** her commit'in author ve committer'ı `tuzlu07x <86893131+tuzlu07x@users.noreply.github.com>` olur. `Co-Authored-By` satırı eklenmez.
- **PR ve merge:** her issue için ayrı bir PR açılır; CI yeşil olmadan merge edilmez. `AGENTS.md`'deki güvenlik kuralları geçerlidir: onay, kimlik, politika, audit ve sır yönetimi asla zayıflatılmaz.
- **Testler ve QA:** testler her zaman geçici bir `FOREMAN_HOME` ile çalışır. QA'da gerçek `claude` CLI'ı çalıştırılmaz; stand-in agent'lar kullanılır.
- **Yayın:** npm yayınını ve release tag'ini kullanıcı (paket sahibi) yapar.

---

## 2. Yapılanlar

### 2.1 Temel (v0.1.x → #609 ve sonrası)
- **Güvenlik tabanı:**
  - fail-closed Claude Code hook;
  - HMAC imzalı Telegram onay butonları;
  - politika önceliği;
  - Foreman'ın kendisini korumaya yönelik tamper protection.
- **MCP Hub:**
  - katalog;
  - zehirli tool taraması;
  - rug-pull tespiti için pin'ler;
  - sonuç koruması;
  - lazy discovery;
  - OAuth ile hosted MCP sunucuları (#617, PR #643).
- **Foreman Org:**
  - departmanlar, roller, raporlama hatları;
  - departman kanalları;
  - bütçe, harcama ve aktivite raporları;
  - yöneticiye onay danışma (#623, PR #649).
- **Bildirimler:**
  - Telegram (ayrı onay botu);
  - iki yönlü Slack (Socket Mode) ve Discord;
  - e-posta, ntfy, webhook.
- **TUI:**
  - modern tasarım;
  - komut çubuğu (`:`);
  - bildirim merkezi;
  - onay kuyruğu;
  - `foreman demo` (phishing senaryosu, stand-in agent'larla).
- **Kalite:**
  - Node 22+;
  - `verify` kapısı;
  - CodeQL;
  - uçtan uca QA paketi (`npm run qa`, 8 senaryo).

### 2.2 Bu dönemde merge edilen PR'lar
| PR | Konu |
|---|---|
| #640 | Hook yalnızca Foreman'ın gerçek MCP sunucusuna güvenir (#619); hub drift ve withheld kayıtları; webhook https zorunluluğu; onayı kimin verdiği kaydı (`resolved_via`) |
| #641 | Release pipeline: npm provenance, her mimaride native binary, SHA'ya sabitlenmiş action'lar (#620) |
| #642 | Claude Code hook QA senaryosu; "önceden reddedildi" kuralı düzeltmesi (#624) |
| #643 | Hosted MCP sunucuları için OAuth (#617) |
| #645 | Agent kayıt defteri (registry) upstream ile karşılaştırıldı (#591) |
| #647 | MCP SDK 1.30.1, drizzle yamaları, eski veritabanı yükseltme testi (#590, #592) |
| #648 | Devre dışı agent devre dışı kalır; temiz kapanış; testler için izole home |
| #649 | Düşük/orta riskli onaylar requester'ın yöneticisine danışılır (#623) |
| #650 | Standalone binary'ler Node SEA ile üretiliyor; 4 platformda dry-run yeşil |
| #651 | Production npm audit uyarıları temizlendi; `db:check` düzeldi |
| #652 | better-sqlite3 13; `.npmrc` `ignore-scripts=true` (hiçbir bağımlılık install script'i çalışmaz) (#644) |
| #653 | Setup wizard modüllere bölündü, 21 wizard hatası giderildi (#621) |
| #654 | OpenClaw'ın Node ≥ 24.16 gereksinimi açıklanıyor; kurulum yarıda patlamıyor (#646) |
| #655 | **Her agent'a ayrı kimlik token'ı** (MCP yolunda sahte kimliğe karşı) (#618) |
| #659 | Son kullanıcı QA'sının güvenlik bulguları (#656) |
| #660 | Son kullanıcı QA'sının CLI/TUI bulguları (#657) |
| #661 | Doküman yenilemesi; yeni `docs/policy.md` (#658) |

**#659 ile gelen önemli güvenlik değişiklikleri:**
- **Agent'lar Foreman'ı yönetemez.** Durdurma ve model değiştirme gibi komutlar kullanıcı onayı ister.
- **Gizli terminal kodları görünür.** Onay ekranında görünür sembol olarak gösterilir, bir yolu saklayamaz.
- **Kritik riskli onaylar iki tuş ister** (`a`, sonra `y`).
- **Politika değişiklikleri canlı uygulanır.** Kural numaraları kalıcıdır.
- **Agent'lar arası kurallar çalışır.** `can_call` / `cannot_call` gerçekten uygulanır.
- **`.env` koruması her agent'ı kapsar.** Hermes, OpenClaw ve ZeroClaw da buna dahil.
- **`tokens_per_hour` uygulanıyor.**
- **Webhook imzası zaman damgalı.** Bu değişiklik mevcut webhook alıcılarını kırar; sürüm notunda belirtilmeli.

**#660 ile gelenler:**
- Log aramasındaki çökme giderildi.
- Silme ve kaldırma işlemleri onay istiyor.
- `agent remove` artık agent programını silmiyor.
- `agent add claude-code` `--type` olmadan çalışıyor.
- doctor hiçbir dosya oluşturmuyor.
- `notify enable` gerekli alanları dolduruyor.
- Ekran 80x24'e sığıyor.
- İkinci `foreman start` reddediliyor.

### 2.3 Durum (sayılar)
- **Testler:** yaklaşık 349 test dosyası ve 4.670 test; `npm run qa` 8/8.
- **CI:** verify, Linux (Node 22/24), Windows WSL2, QA, CodeQL, registry validate.
- **Açık issue'lar (5):**
  - #594 stdio güvenilirliği;
  - #616 paylaşılan hub daemon;
  - #622 ESLint/Prettier;
  - #625 lansman materyalleri ve v0.2.0;
  - #626 v0.2 yol haritası.

---

## 3. Yapılacaklar (önerilen sıra)

### 3.1 Entegrasyonlar: GitHub, GitLab, Jira/Confluence, Trello, Linear, Notion
- **Plan:** [`docs/plans/integrations.md`](plans/integrations.md), onaylı, 5 PR'lık.
- **Yaklaşım:** her entegrasyon MCP hub'daki bir sunucunun üstünde bir katman. Böylece politika, onay, audit ve pin'ler aynen geçerli; yeni tablo yok.
- **Yönetim:** entegrasyonlar kurulumda isteğe bağlı. Sonradan TUI (`i` sayfası), CLI (`foreman integrations …`) ve chat'ten (`/integration enable github` vb.) eklenip güncellenip silinir, açılıp kapatılır.
- **Chat'ten değişiklik** sadece sahip yapabilir (Slack/Discord'da `owner_user_ids`, Telegram onay botunda DM). Şifreler chat'e asla yazılmaz.
- **PR 1** (katalog ve model) yarım durumda. WIP commit'i `claude/busy-wright-gn17l6` branch'inde, eski main üstünde; incelenmedi, testleri eksik. Önce main'e rebase et, `service.ts` ve testleri tamamla.
- **PR 2 ve PR 5** (hub yetkilendirmesi, chat komutları) #656'ya bağlıydı; #656 artık merge oldu, bu bağımlılık kalktı.
- **Sonra:** entegrasyonların adım adım son kullanıcı QA'sı ve bulunanların düzeltilmesi.

### 3.2 LLM modelleri: hep güncel, kolay değişen
Mevcut durum:

- **Foreman'ın kendi beyni:**
  - Claude varsayılanı Haiku 4.5; güncel ve hızlı/ucuz kontroller için doğru seçim.
  - OpenAI varsayılanı `gpt-4o-mini` ve Gemini varsayılanı `gemini-2.0-flash` eski.
  - Yardım metinlerindeki `claude-opus-4-7` ve `claude-sonnet-4-6` önceki nesil. Güncel Claude modelleri: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`.
- **Kurulum sihirbazı** model listesini sağlayıcının API'sinden canlı çekiyor.
- **Model değiştirme:**
  - **TUI:** yalnızca komut çubuğundan (`:model <model>` / `:model <agent> <model>`). Seçici bir liste yok.
  - **Slack/Discord:** `/foreman model …` ile anında değişir.
  - **Telegram:** agent aktarımıyla geldiği için onay ister.

Önerilen yöntem:

1. **Kayıt defterinden güncel liste.** `registry/llm-models.json` dosyası, sağlayıcı başına "önerilen / hızlı-ucuz / en güçlü" modelleri ve fiyatlarını tutar. `foreman registry update` ile güncellenebilir, böylece yeni bir model çıkınca npm sürümü beklemeden eklenebilir.
2. **Canlı listeden seçim.** Sağlayıcı API'sinden gelen liste TUI'deki yeni model seçicide (↑↓, Foreman ve her agent için) ve chat'teki butonlu `/model` komutunda kullanılır. Listede yeni çıkan bir model varsa hemen seçilebilir.
3. **Güncel varsayılanlar.** OpenAI, Gemini ve örneklerdeki varsayılan modeller ve harcama raporlarındaki fiyat tabloları güncel sürümlere çekilir. Doğrulama canlı API'den yapılır, ezbere model adı yazılmaz.
4. **Agent başına model sabitleme** TUI'den de yapılabilir hale gelir.

### 3.3 Şirket simülasyonu testi (kalıcı QA senaryosu `09-company-slack`)
- **Kurgu:**
  - Finans, Pazarlama ve IT departmanları var, her birinin ayrı Slack kanalı ve stand-in bir agent'ı var.
  - Foreman bütün kanallarda denetçi; patron da bütün kanallarda.
  - Slack için sahte bir Slack sunucusu kullanılır (Web API ve Socket Mode); CI'da her seferinde çalışır.
- **Senaryolar:**
  - departman içi iletişim;
  - Slack'ten onay ve ret;
  - bütçe aşımı;
  - "rapor ver" isteğine raporun gelmesi;
  - departmanlar arası sınır ihlali;
  - chat'ten entegrasyon açıp kapatma;
  - TUI'nin tüm bunları doğru yansıtması.
- Bulunan her şey düzeltilir.

### 3.4 Uçtan uca final QA, sürüm yükseltmeleri, TUI tasarımı
- **Final QA:** sıfırdan son kullanıcı testi yapılır; kırık ve darboğazlar düzeltilir.
- **Sürüm yükseltmeleri:**
  - Claude/OpenAI/Gemini SDK'ları;
  - agent kayıt defteri (Hermes, OpenClaw, Codex, ZeroClaw kurulum yöntemleri);
  - ana sürüm değişikliği gerektiren npm bağımlılıkları (vitest 5, drizzle-kit).
- **TUI:** temiz, modern, hızlı ve kullanıcı dostu olacak şekilde tasarım cilası.

### 3.5 Kalan issue'lar
- **#622 ESLint + Prettier.** Formatlama bütün dosyalara dokunduğu için en sona bırakılmalı; ayrıca `.git-blame-ignore-revs` eklenmeli.
- **#616 paylaşılan MCP hub daemon** ve **#594 stdio güvenilirliği.**

### 3.6 v0.2.0 sürümü ve npm (yayını kullanıcı yapar)

**Hazırlık:**
- `package.json` sürümünü `0.2.0` yap, sonra `npm install --package-lock-only` çalıştır.
- CHANGELOG'da "Unreleased" başlığını `## [0.2.0] - tarih` yap.
- Sürüm notlarına kırıcı değişiklikleri yaz: webhook imzası, `agent remove` davranışı, `report` çıktısının tablo olması, kimlik token'ları için `foreman agent rewire --all`.

**Bir kerelik kurulum:**
- npmjs.com → Access Tokens → Granular token, yalnızca `foreman-agent` için, read-write.
- GitHub → Settings → Environments → `npm` ortamını oluştur, `NPM_TOKEN` secret'ını ekle. İstersen required reviewer olarak kendini ekle.

**Yayın:**
1. PR'ı merge et.
2. Actions → `release-npm` → Run workflow (`dry_run` açık) ile dene.
3. GitHub → Releases → `v0.2.0` tag'i (hedef `main`) → Publish.
4. Workflow'lar npm'e provenance ile yayınlar, 4 binary ile SHA256SUMS dosyasını ekler ve Homebrew PR'ı açar.
5. Kontrol: `npm view foreman-agent version`.

**Geri alma:**
- `npm dist-tag add foreman-agent@0.1.6 latest`
- `npm deprecate foreman-agent@0.2.0 "sebep"`
- `unpublish` kullanılmaz.

**Lansman materyalleri (#625):** demo kaydı (asciinema, GIF, SVG), TUI ekran görüntüleri, README'nin üst kısmında demo.

### 3.7 Son teslimler
- Kullanıcının uçtan uca test edebileceği temiz bir README.
- Kullanıcı için adım adım test listesi: kendi PC'sine kurup denemesi için.
- Yapılan işlerin raporu.
- **foreman-agent.com** için revizyon önerileri.
- **Popülerlik planı:**
  - good-first-issue'lar;
  - katkı rehberi;
  - entegrasyon/eklenti yazma rehberi;
  - demo GIF ve rozetler;
  - düzenli sürüm takvimi;
  - Show HN, Product Hunt, Reddit ve X lansmanı.

  `LAUNCH.md` ve önceki lansman planı temel alınır.

### 3.8 QA'dan kalan küçük işler
- **M8:** `agent remove` agent'ın config'indeki `foreman` MCP girdisini ve Claude Code hook'unu geride bırakıyor.
- `foreman secrets list` agent token adlarını gösteriyor (TUI'deki Keys sayfası gizliyor).
- `foreman hook` ve `secrets repush` yardım metinlerinde hâlâ issue numaraları var.
- Güvenlik raporu, izin verilen çağrılar için "onay istendi" yazıyor.
- doctor'ın FTS5 kontrolü `init`'ten önce de "hazır" diyor.
- `agent show` public key'i göstermiyor.
- `org check` mesajı iyileştirilmeli.
- `can_call_agents_with_responsibility` şemada var ama uygulanmıyor.
- `docs/architecture.md`'deki wizard bölümü eski; 4 adımdan bahsediyor, şu an 5 adım var.
- TUI yardım ekranında kritik onaydaki "sonra `y`" bilgisi eksik.

---

## 4. Açık kararlar

1. **Eski ortak kullanım anahtarı.**
   - **Sorun:** agent'lar harcamalarını Foreman'a bu anahtarla raporluyor. Eskiden tüm agent'lar aynı anahtarı kullanıyordu ve raporda kim olduklarını kendileri söylüyordu. Bu yüzden bir agent harcamasını başka bir departmana yazdırabilirdi.
   - **Şimdiki durum:** her agent'ın kendi imzalı anahtarı var. Eski anahtar ise geriye uyumluluk için hâlâ kabul ediliyor.
   - **Öneri:** v0.2.0'da eski anahtar kullanılınca doctor ve inbox uyarı versin; v0.3.0'da eski anahtar reddedilsin.
2. **Şüpheli ama izin verilen agent-agent devirleri.** Döngü, rol ihlali, bütçe veya tehlikeli içerik gibi durumlar zaten onay istiyor ve bildirim gönderiyor. Ama tek başına düşük riskli tuhaflıklar (ör. iki agent'ın ilk kez konuşması) sadece kayda geçiyor. Bunlar için günlük özet veya bilgi bildirimi eklensin mi?
3. **Doctor'da "info" seviyesi yok.** Generic MCP agent'ı kayıtlı olduğu sürece doctor uyarı verip 1 koduyla çıkıyor.
4. **Wizard'da Ctrl-C 0 koduyla çıkıyor.** Bunun 130 olması gerekip gerekmediğine karar verilmeli.
5. **Karar verildi:** bozuk `policy.yaml` hook'u ve yeni başlayan süreçleri durdurur (fail-closed); bu şekilde kalıyor. Agent'tan agent'a iş verme onaysız yürür, sorun tespit edilirse bildirilir.

---

## 5. Yeni oturuma başlarken

1. `git pull origin main`, sonra sırayla şunları oku:
   - bu dosya;
   - `AGENTS.md`;
   - `CONTRIBUTING.md`;
   - `docs/plans/integrations.md`.
2. Entegrasyonların yarım kalan PR 1'i: `git fetch origin claude/busy-wright-gn17l6` ile al. En üstteki commit "wip(integrations): catalog and model (PR 1, unfinished)" başlıklı. Bu commit eski bir main (`471db83`) üzerinde; önce main'e rebase et.
3. Kontrol komutları:
   ```bash
   npm ci
   npm run lint
   npm test
   npm run build
   npm run qa
   node dist/cli/index.js registry validate
   ```
4. Güvenlik kuralları:
   - TUI ve CLI denemelerini her zaman geçici bir `FOREMAN_HOME` ve `HOME` ile yap.
   - QA'da gerçek agent CLI'larını çalıştırma.
   - `.env` dosyalarını okuma.
5. İş akışı: her issue için bir PR aç, CI'ı yeşile getir (CodeQL uyarıları dahil), sonra merge et. Commit kimliği: `tuzlu07x`, `Co-Authored-By` yok.

**Önerilen ilk komut (yeni oturumda):**

> `docs/project-status.md` dosyasını oku ve bölüm 3.1'den (entegrasyonlar) devam et. PR 1'i main'e rebase et, eksiklerini tamamla, test et, PR aç ve merge et. Sonra PR 2–5'i sırayla yap. Bitince bölüm 3.2'ye (LLM modelleri) geç.
