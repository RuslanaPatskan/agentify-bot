# Agentify Telegram Bot — Cloudflare Workers

Безкоштовний Telegram бот для імпорту кандидатів в Teamtailor.
Працює на Cloudflare Workers — безкоштовно назавжди, не засинає.

## Розгортання через Cloudflare Dashboard (без коду)

### Крок 1 — Створити Worker
1. Зайди на dash.cloudflare.com
2. Workers & Pages → Create → Create Worker
3. Назви: `agentify-bot`
4. Натисни Deploy
5. Натисни Edit code
6. Видали весь код → встав вміст файлу `worker.js`
7. Deploy

### Крок 2 — Створити KV namespace
1. Workers & Pages → KV → Create namespace
2. Назва: `agentify-sessions`
3. Скопіюй ID namespace
4. Зайди в свій Worker → Settings → Bindings
5. Add binding → KV namespace
6. Variable name: `SESSIONS`
7. KV namespace: вибери `agentify-sessions`
8. Save

### Крок 3 — Додати змінні середовища
Workers → agentify-bot → Settings → Variables → Add variable:
- `TELEGRAM_TOKEN` = токен від @BotFather
- `TT_API_KEY` = API ключ Teamtailor  
- `ALLOWED_USERS` = твій Telegram ID (дізнайся у @userinfobot)

Натисни Encrypt для кожної змінної → Save

### Крок 4 — Зареєструвати webhook
Відкрий в браузері:
```
https://agentify-bot.YOUR-SUBDOMAIN.workers.dev/setup
```
Має з'явитись: `{"ok":true,"result":true}`

### Крок 5 — Тест
Напиши /start своєму боту в Telegram 🎉

## Команди бота
- `/start` — запуск
- `/help` — інструкція  
- `/add Ім'я @username +380XX` — ручне додавання
- `💼 Вибрати вакансію` — прив'язка до вакансії
