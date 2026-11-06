// Tela Pagamentos: soma dos selecionados, "selecionar todos", limpar e confirmação antes de marcar como pagos.
const f = document.querySelector('form[data-pagar]');
if (f) {
  const cx = [...f.querySelectorAll('input[name=sel]')], todos = f.querySelector('[data-todos]'), btn = f.querySelector('[data-pagar-btn]');
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const marcados = () => cx.filter((c) => c.checked);
  const atual = () => {
    const m = marcados();
    f.querySelector('#sel-rot').textContent = m.length ? m.length + (m.length > 1 ? ' fechamentos selecionados' : ' fechamento selecionado') + ' · soma' : 'Nenhum fechamento selecionado';
    f.querySelector('#sel-total').textContent = brl(m.reduce((s, c) => s + Number(c.dataset.v), 0));
    btn.disabled = !m.length;
    if (todos) todos.checked = cx.length > 0 && m.length === cx.length;
  };
  cx.forEach((c) => c.addEventListener('change', atual));
  todos?.addEventListener('change', () => { cx.forEach((c) => { c.checked = todos.checked; }); atual(); });
  f.querySelector('[data-limpar]')?.addEventListener('click', () => { cx.forEach((c) => { c.checked = false; }); atual(); });
  f.addEventListener('submit', (e) => {
    if (!confirm('Marcar ' + marcados().length + ' fechamento(s) como PAGO, total ' + f.querySelector('#sel-total').textContent + '?')) e.preventDefault();
  });
  atual();
}
