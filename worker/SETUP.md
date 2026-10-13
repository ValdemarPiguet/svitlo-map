# Автоматичне оновлення графіків: покрокова інструкція

Після налаштування:
- Worker (Cloudflare) сам запускає оновлення о :17 (UTC 03, 11, 18, 21: влітку це 06:17, 14:17, 21:17 і 00:17 за Києвом, взимку на годину раніше).
- GitHub має резервний запуск о :47 (на випадок, якщо Worker не спрацював).
- Worker о :57 перевіряє, чи оновились дані. Якщо ні, вам приходить повідомлення в Telegram з кнопкою «🔄 Оновити зараз».
- Раз на 3 години (разом із моніторингом екстрених відключень) Worker перевіряє, що дані не старші за 10 годин. Повідомлення не частіше, ніж раз на 6 годин.
- Вручну: напишіть боту `/update`.

## Крок 1. Токен GitHub (5 хвилин)
1. github.com → аватар зверху праворуч → **Settings**.
2. Лівий список, внизу: **Developer settings**.
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
4. **Token name:** `svitlo-worker`. **Expiration:** 1 year (поставте нагадування в календарі).
5. **Resource owner:** ваш акаунт.
6. **Repository access:** *Only select repositories* → оберіть `svitlo-map`.
7. **Permissions** → **Repository permissions** → знайдіть **Actions** → *Access:* **Read and write** (Metadata: Read-only з'явиться сам).
8. **Generate token** і одразу скопіюйте токен (починається з `github_pat_`). Він показується один раз. Нікому його не надсилайте.

## Крок 2. Cloudflare
1. dash.cloudflare.com → **Workers & Pages** → відкрийте ваш Worker (`quiet-brook-27e0`).
2. **Edit code** → виділіть увесь код (Ctrl/Cmd + A), видаліть, вставте весь вміст файлу `svitlo-worker.js` → **Deploy**.
3. **Settings → Variables and Secrets → Add**. Додайте дві змінні (інші, що вже є, не чіпайте):
   - Type **Secret**, name `GH_TOKEN`, value: токен із кроку 1.
   - Type **Text**, name `GH_REPO`, value: `valdemarpiguet/svitlo-data` (репозиторій, де працює робот; токен із кроку 1 має бути виданий саме для нього).
   - Type **Text**, name `DATA_URL`, value: `https://valdemarpiguet.github.io/svitlo-data/data/ua.json`.
4. **Settings → Triggers → Cron Triggers → Add**. Додайте два розклади (існуючий `7 */3 * * *` лишається):
   - `17 3,11,18,21 * * *`
   - `57 3,11,18,21 * * *`
5. Натисніть **Deploy**, якщо Cloudflare просить застосувати зміни.

## Крок 3. GitHub: оновіть workflow
Відкрийте в репозиторії `.github/workflows/update.yml` → олівець → замініть увесь вміст вмістом нового файлу `update.yml` → **Commit changes**. (У ньому резервний розклад перенесено на :47 і додано `git pull --rebase` перед `push`.)

## Крок 4. Перевірка
1. У Telegram напишіть боту: `/update`. Відповідь: «✅ Оновлення запущено».
2. GitHub → **Actions** → за 1–2 хвилини з'явиться запуск *Update outage data* (подія *workflow_dispatch*), статус зелений.
3. Через 2–3 хвилини напишіть `/checkdata`: «✅ Дані свіжі: оновлено … (N хв тому)». Рядок про дані є і в `/status`.
4. Далі нічого робити не треба. Якщо повідомлень «Графіки не оновлювались» немає, усе працює.

## Якщо щось не так
| Що пише бот | Причина | Що робити |
|---|---|---|
| `HTTP 401: Bad credentials` | токен неправильний або сплив | створіть новий токен (крок 1) і замініть секрет `GH_TOKEN` |
| `HTTP 403: Resource not accessible…` | у токена немає права Actions: Read and write або вибрано не той репозиторій | створіть токен знову за кроком 1 |
| `HTTP 404` | неправильне значення `GH_REPO` або workflow не називається `update.yml` | перевірте `GH_REPO` (`владелец/репозиторій`) |
| `GH_TOKEN або GH_REPO не задано` | змінні не додано або не застосовано | додайте їх і натисніть Deploy |
| бот не відповідає на `/update` | Worker не оновлено | повторіть крок 2 (вставте код і Deploy) |
| «Не вдалося перевірити дані сайту» | сайт недоступний або змінена адреса | перевірте, що відкривається `https://valdemarpiguet.github.io/svitlo-map/data/ua.json` |

Токен діє рік. Коли він спливе, Worker напише: «Не вдалося запустити оновлення даних у GitHub».
