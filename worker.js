// ============================================================
// Agentify Telegram Bot — Cloudflare Workers (webhook)
// Імпортує кандидатів з Telegram в Teamtailor
// ============================================================

const TT_BASE        = 'https://api.teamtailor.com/v1';
const TT_API_VERSION = '20240904';

// ── KV Storage keys ────────────────────────────────────────
// Зберігаємо сесії в Cloudflare KV (SESSIONS binding)
const SESSION_TTL = 60 * 60 * 24; // 24 години

// ── Helpers ────────────────────────────────────────────────
const ttHeaders = (apiKey) => ({
  'Authorization': `Token token=${apiKey}`,
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
        await sleep(Math.pow(2, i) * 600);
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < maxTries - 1) await sleep(Math.pow(2, i) * 600);
    }
  }
  throw lastErr;
}

// ── Telegram API ───────────────────────────────────────────
async function tgCall(method, params, token) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params)
  });
  return resp.json();
}

async function sendMessage(chatId, text, extra, token) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra }, token);
}

async function deleteMessage(chatId, messageId, token) {
  return tgCall('deleteMessage', { chat_id: chatId, message_id: messageId }, token);
}

// ── Сесії через KV ─────────────────────────────────────────
async function getSession(userId, kv) {
  try {
    const raw = await kv.get(`session:${userId}`);
    return raw ? JSON.parse(raw) : { jobId: null, jobTitle: null, awaitingJob: false, pendingCandidate: null };
  } catch (e) {
    return { jobId: null, jobTitle: null, awaitingJob: false, pendingCandidate: null };
  }
}

async function saveSession(userId, session, kv) {
  await kv.put(`session:${userId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
}

// ── Teamtailor API ─────────────────────────────────────────
async function getJobs(apiKey) {
  try {
    const r = await fetchWithRetry(
      `${TT_BASE}/jobs?filter[status]=open&page[size]=50`,
      { headers: ttHeaders(apiKey) }
    );
    if (!r.ok) return [];
    const b = await r.json();
    return b.data || [];
  } catch (e) { return []; }
}

async function checkDuplicate(phone, username, apiKey) {
  if (phone) {
    try {
      const r = await fetchWithRetry(
        `${TT_BASE}/candidates?filter[phone]=${encodeURIComponent(phone.replace(/[^0-9+]/g, ''))}`,
        { headers: ttHeaders(apiKey) }
      );
      if (r.ok) {
        const b = await r.json();
        if (b?.data?.length > 0) {
          const c = b.data[0];
          return { id: c.id, name: `${c.attributes?.['first-name'] || ''} ${c.attributes?.['last-name'] || ''}`.trim() };
        }
      }
    } catch (e) {}
  }
  if (username) {
    try {
      const r = await fetchWithRetry(
        `${TT_BASE}/candidates?filter[query]=${encodeURIComponent('@' + username)}&page[size]=5`,
        { headers: ttHeaders(apiKey) }
      );
      if (r.ok) {
        const b = await r.json();
        if (b?.data?.length > 0) {
          const c = b.data[0];
          return { id: c.id, name: `${c.attributes?.['first-name'] || ''} ${c.attributes?.['last-name'] || ''}`.trim() };
        }
      }
    } catch (e) {}
  }
  return null;
}

async function createCandidate({ firstName, lastName, phone, username, messageText, jobId }, apiKey) {
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
    method: 'POST', headers: ttHeaders(apiKey), body: JSON.stringify(payload)
  });
  const body = await resp.json();

  if (!resp.ok) {
    const msg = body?.errors?.[0]?.detail || JSON.stringify(body);
    throw new Error(`Teamtailor помилка (${resp.status}): ${msg}`);
  }

  const cId = body?.data?.id;

  if (cId && jobId) {
    try {
      await fetchWithRetry(`${TT_BASE}/job-applications`, {
        method: 'POST', headers: ttHeaders(apiKey),
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

  if (cId && notes) {
    try {
      await fetchWithRetry(`${TT_BASE}/notes`, {
        method: 'POST', headers: ttHeaders(apiKey),
        body: JSON.stringify({
          data: {
            type: 'notes',
            attributes: { body: notes },
            relationships: { candidate: { data: { type: 'candidates', id: String(cId) } } }
          }
        })
      });
    } catch (e) {}
  }

  return { candidateId: cId, url: `https://app.teamtailor.com/candidates/${cId}` };
}

// ── Клавіатури ─────────────────────────────────────────────
const mainKeyboard = () => ({
  reply_markup: JSON.stringify({
    keyboard: [
      ['💼 Вибрати вакансію', '📋 Поточна вакансія'],
      ['❓ Допомога']
    ],
    resize_keyboard: true
  })
});

const jobsKeyboard = (jobs) => ({
  reply_markup: JSON.stringify({
    keyboard: [
      ...jobs.map(j => [{ text: `${j.attributes?.title || 'Без назви'} · ${j.id}` }]),
      [{ text: '❌ Без прив\'язки до вакансії' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  })
});

const confirmKeyboard = () => ({
  reply_markup: JSON.stringify({
    keyboard: [
      ['✅ Підтвердити імпорт'],
      ['❌ Скасувати']
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  })
});

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
// ГОЛОВНИЙ ОБРОБНИК
// ════════════════════════════════════════════════════════════
async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId  = msg.chat.id;
  const userId  = msg.from?.id;
  const text    = msg.text || '';
  const token   = env.TELEGRAM_TOKEN;
  const apiKey  = env.TT_API_KEY;
  const kv      = env.SESSIONS;

  // перевірка доступу
  const allowed = (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(userId))) {
    return sendMessage(chatId, '⛔ Доступ заборонено.', {}, token);
  }

  const session = await getSession(userId, kv);

  // ── /start ──
  if (text === '/start') {
    await saveSession(userId, { jobId: null, jobTitle: null, awaitingJob: false, pendingCandidate: null }, kv);
    return sendMessage(chatId,
      `👋 Привіт, *${msg.from.first_name}*!\n\n` +
      `Я імпортую кандидатів з Telegram в Teamtailor.\n\n` +
      `*Як користуватись:*\n` +
      `1️⃣ Вибери вакансію (необов'язково)\n` +
      `2️⃣ Перешли контакт або повідомлення кандидата\n` +
      `3️⃣ Підтверди імпорт\n\n` +
      `Або вручну: \`/add Ім'я @username +380XX\``,
      mainKeyboard(), token
    );
  }

  // ── /help ──
  if (text === '/help' || text === '❓ Допомога') {
    return sendMessage(chatId,
      `*📖 Інструкція:*\n\n` +
      `*Варіант 1 — Поділитись контактом:*\n` +
      `Профіль → ⋮ → "Поділитись контактом" → перешли боту\n\n` +
      `*Варіант 2 — Переслати повідомлення:*\n` +
      `Затримай → "Переслати" → вибери бота\n\n` +
      `*Варіант 3 — Вручну:*\n` +
      `\`/add Ім'я Прізвище @username +380XX\`\n\n` +
      `⚠️ Якщо номер прихований — телефон буде порожнім.`,
      mainKeyboard(), token
    );
  }

  // ── Вибір вакансії ──
  if (text === '💼 Вибрати вакансію') {
    const waitMsg = await sendMessage(chatId, '⏳ Завантажую вакансії...', {}, token);
    const jobs    = await getJobs(apiKey);
    await deleteMessage(chatId, waitMsg.result?.message_id, token);

    if (!jobs.length) {
      return sendMessage(chatId, '❌ Немає відкритих вакансій в Teamtailor.', mainKeyboard(), token);
    }

    session.awaitingJob = true;
    session.jobs = jobs.map(j => ({ id: j.id, title: j.attributes?.title || 'Без назви' }));
    await saveSession(userId, session, kv);
    return sendMessage(chatId, '💼 Вибери вакансію:', jobsKeyboard(jobs), token);
  }

  // ── Поточна вакансія ──
  if (text === '📋 Поточна вакансія') {
    if (session.jobId) {
      return sendMessage(chatId, `✅ Вакансія: *${session.jobTitle}*`, mainKeyboard(), token);
    }
    return sendMessage(chatId, '⚠️ Вакансія не вибрана.', mainKeyboard(), token);
  }

  // ── Вибір вакансії зі списку ──
  if (session.awaitingJob) {
    session.awaitingJob = false;

    if (text.includes('Без прив\'язки') || text.startsWith('❌')) {
      session.jobId    = null;
      session.jobTitle = null;
      await saveSession(userId, session, kv);
      return sendMessage(chatId, '✅ Без прив\'язки до вакансії.', mainKeyboard(), token);
    }

    const idMatch = text.match(/·\s*(\d+)$/);
    if (idMatch) {
      session.jobId    = idMatch[1];
      session.jobTitle = text.replace(/·\s*\d+$/, '').trim();
      await saveSession(userId, session, kv);
      return sendMessage(chatId, `✅ Вакансія: *${session.jobTitle}*`, mainKeyboard(), token);
    }
  }

  // ── /add команда ──
  if (text.startsWith('/add ')) {
    const candidate = parseAddCommand(text);
    session.pendingCandidate = candidate;
    await saveSession(userId, session, kv);

    const dupe = await checkDuplicate(candidate.phone, candidate.username, apiKey);
    if (dupe) {
      return sendMessage(chatId,
        `🚨 *Кандидат вже є в базі!*\n` +
        `Ім'я: ${dupe.name}\n` +
        `[Відкрити профіль](https://app.teamtailor.com/candidates/${dupe.id})\n\n` +
        `Все одно додати?`,
        confirmKeyboard(), token
      );
    }
    return sendMessage(chatId, candidatePreview(candidate, session), confirmKeyboard(), token);
  }

  // ── Підтвердження імпорту ──
  if (text === '✅ Підтвердити імпорт') {
    if (!session.pendingCandidate) {
      return sendMessage(chatId, '⚠️ Немає кандидата. Перешли контакт або повідомлення.', mainKeyboard(), token);
    }

    const waitMsg = await sendMessage(chatId, '⏳ Імпортую в Teamtailor...', {}, token);

    try {
      const result = await createCandidate({ ...session.pendingCandidate, jobId: session.jobId }, apiKey);
      session.pendingCandidate = null;
      await saveSession(userId, session, kv);
      await deleteMessage(chatId, waitMsg.result?.message_id, token);
      return sendMessage(chatId,
        `✅ *Кандидат доданий в Teamtailor!*\n\n` +
        `ID: ${result.candidateId}\n` +
        `[Відкрити профіль](${result.url})`,
        mainKeyboard(), token
      );
    } catch (e) {
      await deleteMessage(chatId, waitMsg.result?.message_id, token);
      return sendMessage(chatId, `❌ Помилка:\n${e.message}`, mainKeyboard(), token);
    }
  }

  // ── Скасування ──
  if (text === '❌ Скасувати') {
    session.pendingCandidate = null;
    await saveSession(userId, session, kv);
    return sendMessage(chatId, '↩️ Скасовано.', mainKeyboard(), token);
  }

  // ── Пересланий контакт або повідомлення ──
  const candidate = extractFromMessage(msg);
  if (candidate) {
    session.pendingCandidate = candidate;
    await saveSession(userId, session, kv);

    const dupe = await checkDuplicate(candidate.phone, candidate.username, apiKey);
    if (dupe) {
      return sendMessage(chatId,
        `🚨 *Кандидат вже є в базі Teamtailor!*\n` +
        `Ім'я: ${dupe.name}\n` +
        `[Відкрити профіль](https://app.teamtailor.com/candidates/${dupe.id})\n\n` +
        `Все одно додати?`,
        confirmKeyboard(), token
      );
    }
    return sendMessage(chatId, candidatePreview(candidate, session), confirmKeyboard(), token);
  }

  // ── Невідоме повідомлення ──
  const menuButtons = ['💼 Вибрати вакансію', '📋 Поточна вакансія', '❓ Допомога', '✅ Підтвердити імпорт', '❌ Скасувати'];
  if (menuButtons.some(b => text.includes(b)) || text.startsWith('/')) return;

  return sendMessage(chatId,
    '📎 Перешли *контакт* або *повідомлення* кандидата,\nабо: `/add Ім\'я @username +380XX`',
    mainKeyboard(), token
  );
}

// ════════════════════════════════════════════════════════════
// CLOUDFLARE WORKERS ENTRY POINT
// ════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return new Response('Agentify Bot — працює ✅', { status: 200 });
    }

    // Webhook endpoint
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
      } catch (e) {
        console.error('Webhook error:', e);
      }
      return new Response('OK', { status: 200 });
    }

    // Реєстрація webhook (викликати один раз)
    if (url.pathname === '/setup' && request.method === 'GET') {
      const token       = env.TELEGRAM_TOKEN;
      const workerUrl   = `https://${url.hostname}/webhook`;
      const resp        = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${workerUrl}`);
      const result      = await resp.json();
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
