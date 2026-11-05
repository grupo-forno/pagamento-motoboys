// Abre/fecha diálogos de cadastro e filtra listas pelo texto digitado.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-abre]'); if (a) { const d = document.getElementById(a.dataset.abre); d.showModal(); d.querySelector('input:not([type=hidden])')?.focus(); }
  const f = e.target.closest('[data-fecha]'); if (f) f.closest('dialog').close();
});
document.querySelectorAll('[data-busca]').forEach((i) => i.addEventListener('input', () => {
  const q = i.value.trim().toLowerCase(), itens = [...document.querySelectorAll(i.dataset.busca)];
  itens.forEach((el) => { el.hidden = !!q && !(el.querySelector('summary') || el).textContent.toLowerCase().includes(q); });
  const vazio = document.getElementById('vazio-busca'); if (vazio) vazio.hidden = itens.some((el) => !el.hidden);
}));
