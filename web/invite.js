const status = document.getElementById('status');
const token = location.hash.slice(1);
const copy = document.getElementById('copy');
const code = document.getElementById('code');
history.replaceState(null, '', '/invite');
const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
async function check() {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { status.textContent = 'В ссылке нет корректного приглашения. Запросите новую ссылку у владельца.'; return; }
  try {
    const response = await fetch('/v1/invite/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: token }), cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) { status.textContent = response.status === 409 ? 'Комната заполнена. Попросите владельца освободить место.' : 'Приглашение истекло или было отозвано.'; return; }
    code.value = token; copy.disabled = false;
    if (mobile) status.textContent = 'Для прослушивания нужен поддерживаемый настольный клиент Windows. Сохраните код и откройте его на компьютере.';
    else status.textContent = 'Приглашение действует. Скопируйте код и вставьте его в панели «Слушать вместе» в Яндекс Музыке.';
  } catch { status.textContent = 'Не удалось связаться с комнатой. Обновите страницу и попробуйте ещё раз.'; }
}
copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(token); status.textContent = 'Код скопирован.'; } catch { code.focus(); code.select(); status.textContent = 'Скопируйте выделенный код вручную.'; } });
void check();
