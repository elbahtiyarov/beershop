// Отправка уведомлений в WhatsApp через бесплатный сервис CallMeBot.
//
// Как подключить:
// 1. Добавьте номер CallMeBot в контакты WhatsApp: +34 644 59 71 65
// 2. Отправьте этому номеру сообщение: "I allow callmebot to send me messages"
// 3. В ответ придёт ваш персональный apikey.
// 4. Впишите в .env:
//      CALLMEBOT_PHONE=+77001234567   (ваш номер в международном формате)
//      CALLMEBOT_APIKEY=123456
//
// Если переменные не заданы — функция просто ничего не делает (не ломает работу кассы).

async function sendWhatsApp(message) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) return; // уведомления не настроены — тихо пропускаем

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error('CallMeBot: ошибка отправки, HTTP', res.status);
    }
  } catch (err) {
    console.error('CallMeBot: не удалось отправить уведомление —', err.message);
  }
}

module.exports = { sendWhatsApp };
