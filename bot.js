// ============================================================
// Agentify Telegram Bot — bot.js
// Імпортує кандидатів з Telegram в Teamtailor
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// ── Конфігурація ───────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TT_API_KEY     = process.env.TT_API_KEY;
const TT_BASE        = 'https://api.teamtailor.com/v1';
const TT_API_VERSION = '20240904';
const ALLOWED_USERS  = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN не вказано');
if (!TT_API_KEY)     throw new Error('TT_API_KEY не вказано');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ── Стан сесій ─────────────────────────────────────────────
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { jobId: null, jobTitle: null, awaitingJob: false, pendingCandidate: null };
  }
  return sessions[userId];
}

// ── Teamtailor helpers ─────────────────────────────────────
const ttHeaders = () => ({
  'Authorization': `Token token=${TT_API_KEY}`,
  'Content-Type':  'application/vnd.api+json',
  'Accept':        'application/vnd.api+json',
  'X-Api-Version': TT_API_VERSION
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, options = {}, maxTries = 3) {
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    try {
      const resp = await fetch(url, options);
      if ((resp.status === 429 || resp.status >= 500) && i < maxTries - 1) {
        await sleep(Math.pow(2, i) * 700);
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < maxTries - 1) await sleep(Math.pow(2, i) * 700);
    }
  }
  throw lastErr;
}

async function getJobs() {
  try {
    const r = await fetchWithRetry(
      `${TT_BASE}/jobs?filter[status]=open&page[size]=50`,
      { headers: ttHeaders() }
    );
    if (!r.ok) return [];
    const b = await r.json();
    return b.data || [];
  } catch (e) { return []; }
}

async function checkDuplicate(phone, username) {
  if (phone) {
    try {
      const r = await fetchWithRetry(
        `${TT_BASE}/candidates?filter[phone]=${encodeURIComponent(phone.replace(/[^0-9+]/g, ''))}`,
        { headers: ttHeaders() }
      );
      if (r.ok) {
        const b = await r.json();
        if (b?.data?.length > 0) {
          const c = b.data[0];
          return {
            id:   c.id,
            name: `${c.attributes?.['first-name'] || ''} ${c.attributes?.['last-name'] || ''}`.trim()
          };
        }
      }
    } catch (e) {}
  }
  if (username) {
    try {
      const r = await fetchWithRetry(
        `${TT_BASE}/candidates?filter[query]=${encodeURIComponent('@' + username)}&page[size]=5`,
        { headers: ttHeaders() }
      );
      if (r.ok) {
        const b = await r.json();
        if (b?.data?.length > 0) {
          const c = b.data[0];
          return {
            id:   c.id,
            name: `${c.attributes?.['first-name'] || ''} ${c.attributes?.['last-name'] || ''}`.trim()
          };
        }
      }
    } catch (e) {}
  }
  return null;
}

async function createCandidate({ firstName, lastName, phone, username, messageText, jobId }) {
  const noteLines = [
    username    ? `Telegram: @${username}`        : null,
    username    ? `Профіль: t.me/${username}`     : null,
    messageText ? `Повідомлення:\n${messageText}` : null
  ].filter(Boolean);
  const notes = noteLines.join('\n');

  const payload = {
    data: {
      type: 'candidates',
      attributes: {
        'first-name': firstName || 'Невідомо',
        'last-name':  lastName  || '',
        'phone':      phone     || null,
        'pitch':      notes.substring(0, 135),
        'sourced':    true,
        'tags':       ['telegram']
      }
    }
  };

  const resp = await fetchWithRetry(`${TT_BASE}/candidates`, {
    method: 'POST', headers: ttHeaders(), body: JSON.stringify(payload)
  });
  const body = await resp.json();

  if (!resp.ok) {
    const msg = body?.errors?.[0]?.detail || JSON.stringify(body);
    throw new Error(`Teamtailor помилка (${resp.status}): ${msg}`);
  }

  const cId = body?.data?.id;

  // прив'язка до вакансії
  if (cId && jobId) {
    try {
      await fetchWithRetry(`${TT_BASE}/job-applications`, {
        method: 'POST', headers: ttHeaders(),
        body: JSON.stringify({
          data: {
            type: 'job-applications',
            relationships: {
              candidate: { data: { type: 'candidates', id: String(cId) } },
              job:       { data: { type: 'jobs',       id: String(jobId) } }
            }
          }
        })
      });
    } catch (e) {}
  }

  // нотатки з Telegram даними
  if (cId && notes) {
    try {
      await fetchWithRetry(`${TT_BASE}/notes`, {
        method: 'POST', headers: ttHeaders(),
        body: JSON.stringify({
          data: {
            type: 'notes',
            attributes: { body: notes },
            relationships: {
              candidate: { data: { type: 'candidates', id: String(cId) } }
            }
          }
        })
      });
    } catch (e) {}
  }

  return {
    candidateId: cId,
    url: `https://app.teamtailor.com/candidates/${cId}`
  };
}

// ── Клавіатури ─────────────────────────────────────────────
const mainKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ['💼 Вибрати вакансію', '📋 Поточна вакансія'],
      ['❓ Допомога']
    ],
    resize_keyboard: true
  }
});

const jobsKeyboard = (jobs) => ({
  reply_markup: {
    keyboard: [
      ...jobs.map(j => [{ text: `${j.attributes?.title || 'Без назви'} · ${j.id}` }]),
      [{ text: '❌ Без прив\'язки до вакансії' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  }
});

const confirmKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ['✅ Підтвердити імпорт'],
      ['❌ Скасувати']
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  }
});

// ── Перевірка доступу ──────────────────────────────────────
function isAllowed(userId) {
  if (!ALLOWED_USERS.length) return true;
  return ALLOWED_USERS.includes(String(userId));
}

// ── Витягнути дані кандидата ───────────────────────────────
function extractFromMessage(msg) {
  if (msg.contact) {
    return {
      firstName:   msg.contact.first_name   || '',
      lastName:    msg.contact.last_name    || '',
      phone:       msg.contact.phone_number || '',
      username:    msg.contact.username     || '',
      messageText: ''
    };
  }
  if (msg.forward_from) {
    return {
      firstName:   msg.forward_from.first_name || '',
      lastName:    msg.forward_from.last_name  || '',
      phone:       '',
      username:    msg.forward_from.username   || '',
      messageText: msg.text || msg.caption || ''
    };
  }
  if (msg.forward_sender_name) {
    const parts = msg.forward_sender_name.split(' ');
    return {
      firstName:   parts[0] || '',
      lastName:    parts.slice(1).join(' ') || '',
      phone:       '',
      username:    '',
      messageText: msg.text || msg.caption || ''
    };
  }
  return null;
}

function parseAddCommand(text) {
  const parts = text.replace('/add', '').trim().split(/\s+/);
  let firstName = '', lastName = '', username = '', phone = '';
  for (const p of parts) {
    if (p.startsWith('@'))          username  = p.replace('@', '');
    else if (/^\+?\d{7,}$/.test(p)) phone     = p;
    else if (!firstName)            firstName = p;
    else if (!lastName)             lastName  = p;
  }
  return { firstName, lastName, username, phone, messageText: '' };
}

function candidatePreview(candidate, session) {
  const name  = `${candidate.firstName} ${candidate.lastName}`.trim() || 'Невідомо';
  const phone = candidate.phone    || '—';
  const uname = candidate.username ? `@${candidate.username}` : '—';
  const job   = session.jobTitle   || 'без прив\'язки';
  return (
    `👤 *Картка кандидата:*\n\n` +
    `Ім'я: *${name}*\n` +
    `Телефон: ${phone}\n` +
    `Telegram: ${uname}\n` +
    `Вакансія: ${job}\n` +
    `Джерело: telegram\n\n` +
    `Все вірно?`
  );
}

// ════════════════════════════════════════════════════════════
// ОБРОБНИКИ
// ════════════════════════════════════════════════════════════

bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ заборонено.');
  await bot.sendMessage(msg.chat.id,
    `👋 Привіт, *${msg.from.first_name}*!\n\n` +
    `Я імпортую кандидатів з Telegram в Teamtailor.\n\n` +
    `*Як користуватись:*\n` +
    `1️⃣ Вибери вакансію (необов'язково)\n` +
    `2️⃣ Перешли контакт або повідомлення кандидата\n` +
    `3️⃣ Підтверди імпорт\n\n` +
    `Або вручну: \`/add Ім'я @username +380XX\``,
    { parse_mode: 'Markdown', ...mainKeyboard() }
  );
});

bot.onText(/\/help|❓ Допомога/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  await bot.sendMessage(msg.chat.id,
    `*📖 Інструкція:*\n\n` +
    `*Варіант 1 — Поділитись контактом:*\n` +
    `Профіль кандидата → ⋮ → "Поділитись контактом" → перешли боту\n\n` +
    `*Варіант 2 — Переслати повідомлення:*\n` +
    `Затримай на повідомленні → "Переслати" → вибери бота\n\n` +
    `*Варіант 3 — Вручну:*\n` +
    `\`/add Ім'я Прізвище @username +380XXXXXXXXX\`\n\n` +
    `⚠️ Якщо номер прихований — телефон залишиться порожнім.`,
    { parse_mode: 'Markdown', ...mainKeyboard() }
  );
});

bot.onText(/💼 Вибрати вакансію/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const wait = await bot.sendMessage(msg.chat.id, '⏳ Завантажую вакансії...');
  const jobs = await getJobs();
  await bot.deleteMessage(msg.chat.id, wait.message_id);

  if (!jobs.length) {
    return bot.sendMessage(msg.chat.id, '❌ Немає відкритих вакансій в Teamtailor.', mainKeyboard());
  }

  const session = getSession(msg.from.id);
  session.awaitingJob = true;
  session.jobs = jobs;

  await bot.sendMessage(msg.chat.id, '💼 Вибери вакансію:', jobsKeyboard(jobs));
});

bot.onText(/📋 Поточна вакансія/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const s = getSession(msg.from.id);
  if (s.jobId) {
    await bot.sendMessage(msg.chat.id,
      `✅ Вакансія: *${s.jobTitle}*`,
      { parse_mode: 'Markdown', ...mainKeyboard() }
    );
  } else {
    await bot.sendMessage(msg.chat.id, '⚠️ Вакансія не вибрана.', mainKeyboard());
  }
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const candidate = parseAddCommand(match[1]);
  const session   = getSession(msg.from.id);
  session.pendingCandidate = candidate;

  const dupe = await checkDuplicate(candidate.phone, candidate.username);
  if (dupe) {
    return bot.sendMessage(msg.chat.id,
      `🚨 *Кандидат вже є в базі!*\n` +
      `Ім'я: ${dupe.name}\n` +
      `[Відкрити профіль](https://app.teamtailor.com/candidates/${dupe.id})\n\n` +
      `Все одно додати?`,
      { parse_mode: 'Markdown', ...confirmKeyboard() }
    );
  }

  await bot.sendMessage(msg.chat.id,
    candidatePreview(candidate, session),
    { parse_mode: 'Markdown', ...confirmKeyboard() }
  );
});

bot.onText(/✅ Підтвердити імпорт/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const session = getSession(msg.from.id);

  if (!session.pendingCandidate) {
    return bot.sendMessage(msg.chat.id,
      '⚠️ Немає кандидата для імпорту. Перешли контакт або повідомлення.',
      mainKeyboard()
    );
  }

  const wait = await bot.sendMessage(msg.chat.id, '⏳ Імпортую в Teamtailor...');

  try {
    const result = await createCandidate({
      ...session.pendingCandidate,
      jobId: session.jobId
    });
    session.pendingCandidate = null;

    await bot.deleteMessage(msg.chat.id, wait.message_id);
    await bot.sendMessage(msg.chat.id,
      `✅ *Кандидат доданий в Teamtailor!*\n\n` +
      `ID: ${result.candidateId}\n` +
      `[Відкрити профіль](${result.url})`,
      { parse_mode: 'Markdown', ...mainKeyboard() }
    );
  } catch (e) {
    await bot.deleteMessage(msg.chat.id, wait.message_id);
    await bot.sendMessage(msg.chat.id, `❌ Помилка:\n${e.message}`, mainKeyboard());
  }
});

bot.onText(/❌ Скасувати/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  getSession(msg.from.id).pendingCandidate = null;
  await bot.sendMessage(msg.chat.id, '↩️ Скасовано.', mainKeyboard());
});

// Головний обробник — контакти та пересилання
bot.on('message', async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const session = getSession(msg.from.id);
  const text    = msg.text || '';

  // вибір вакансії зі списку
  if (session.awaitingJob) {
    session.awaitingJob = false;

    if (text.includes('Без прив\'язки') || text.startsWith('❌')) {
      session.jobId    = null;
      session.jobTitle = null;
      return bot.sendMessage(msg.chat.id,
        '✅ Кандидати імпортуватимуться без прив\'язки до вакансії.',
        mainKeyboard()
      );
    }

    const idMatch = text.match(/·\s*(\d+)$/);
    if (idMatch) {
      session.jobId    = idMatch[1];
      session.jobTitle = text.replace(/·\s*\d+$/, '').trim();
      return bot.sendMessage(msg.chat.id,
        `✅ Вакансія: *${session.jobTitle}*`,
        { parse_mode: 'Markdown', ...mainKeyboard() }
      );
    }
  }

  // пересланий контакт або повідомлення
  const candidate = extractFromMessage(msg);
  if (candidate) {
    session.pendingCandidate = candidate;

    const dupe = await checkDuplicate(candidate.phone, candidate.username);
    if (dupe) {
      return bot.sendMessage(msg.chat.id,
        `🚨 *Кандидат вже є в базі Teamtailor!*\n` +
        `Ім'я: ${dupe.name}\n` +
        `[Відкрити профіль](https://app.teamtailor.com/candidates/${dupe.id})\n\n` +
        `Все одно додати?`,
        { parse_mode: 'Markdown', ...confirmKeyboard() }
      );
    }

    return bot.sendMessage(msg.chat.id,
      candidatePreview(candidate, session),
      { parse_mode: 'Markdown', ...confirmKeyboard() }
    );
  }

  // ігноруємо кнопки меню
  const menuButtons = ['💼 Вибрати вакансію', '📋 Поточна вакансія', '❓ Допомога', '✅ Підтвердити імпорт', '❌ Скасувати'];
  if (menuButtons.some(b => text.includes(b))) return;
  if (text.startsWith('/')) return;

  await bot.sendMessage(msg.chat.id,
    '📎 Перешли мені *контакт* або *повідомлення* кандидата,\nабо введи вручну: `/add Ім\'я @username +380XX`',
    { parse_mode: 'Markdown', ...mainKeyboard() }
  );
});

console.log('🤖 Agentify Bot запущено');
