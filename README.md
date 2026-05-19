# Agentify Telegram Bot

Бот для імпорту кандидатів з Telegram в Teamtailor.

## Функції
- Імпорт через пересланий контакт
- Імпорт через пересланий повідомлення
- Ручне введення `/add Ім'я @username +380XX`
- Перевірка дублів перед імпортом 🚨
- Прив'язка до вакансії Teamtailor
- Тег `telegram` автоматично

## Розгортання на Koyeb

### Крок 1 — GitHub
1. Зареєструйся на github.com
2. Створи новий репозиторій: `agentify-bot`
3. Завантаж всі файли з цієї папки

### Крок 2 — Koyeb
1. Зайди на koyeb.com → Sign up
2. New App → GitHub → вибери `agentify-bot`
3. **Build command:** `npm install`
4. **Run command:** `npm start`
5. **Environment variables** — додай:
   - `TELEGRAM_TOKEN` = токен від @BotFather
   - `TT_API_KEY` = API ключ Teamtailor
   - `ALLOWED_USERS` = твій Telegram ID (дізнайся у @userinfobot)

### Крок 3 — Запуск
Після деплою напиши `/start` своєму боту в Telegram.

## Команди бота
- `/start` — запуск
- `/help` — інструкція
- `/add Ім'я @username +380XX` — ручне додавання
- Кнопка `💼 Вибрати вакансію` — прив'язка до вакансії
