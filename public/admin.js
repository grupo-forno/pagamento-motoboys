// Filtra a lista pelo texto digitado.
document.querySelectorAll('[data-busca]').forEach((i) => i.addEventListener('input', () => {
  const q = i.value.trim().toLowerCase(), itens = [...document.querySelectorAll(i.dataset.busca)];
  itens.forEach((el) => { el.hidden = !!q && !(el.querySelector('summary') || el).textContent.toLowerCase().includes(q); });
  const vazio = document.getElementById('vazio-busca'); if (vazio) vazio.hidden = itens.some((el) => !el.hidden);
}));
