// Tela Pagamentos: soma dos selecionados, "selecionar todos", limpar e confirmação (quem recebe, PIX e valores) antes de registrar.
const f = document.querySelector('form[data-pagar]');
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
if (f) {
  const cx = [...f.querySelectorAll('input[name=sel]')], todos = f.querySelector('[data-todos]'), btn = f.querySelector('[data-pagar-btn]');
  const marcados = () => cx.filter((c) => c.checked);
  const atual = () => {
    const m = marcados(), n = m.reduce((s, c) => s + JSON.parse(c.dataset.itens).length, 0);
    f.querySelector('#sel-rot').textContent = m.length ? m.length + (m.length > 1 ? ' fechamentos' : ' fechamento') + ' · ' + n + (n === 1 ? ' entregador' : ' entregadores') + ' · total' : 'Nenhum fechamento selecionado';
    f.querySelector('#sel-total').textContent = brl(m.reduce((s, c) => s + Number(c.dataset.v), 0));
    btn.disabled = !m.length;
    if (todos) todos.checked = cx.length > 0 && m.length === cx.length;
  };
  cx.forEach((c) => c.addEventListener('change', atual));
  todos?.addEventListener('change', () => { cx.forEach((c) => { c.checked = todos.checked; }); atual(); });
  f.querySelector('[data-limpar]')?.addEventListener('click', () => { cx.forEach((c) => { c.checked = false; }); atual(); });
  f.addEventListener('submit', (e) => {
    const m = marcados(), linhas = [];
    m.forEach((c) => { linhas.push(c.dataset.rot + ':'); JSON.parse(c.dataset.itens).forEach(([nome, pix, v]) => linhas.push('  • ' + nome + ' · PIX ' + pix + ' · ' + brl(v))); });
    const n = m.reduce((s, c) => s + JSON.parse(c.dataset.itens).length, 0);
    const txt = 'Registrar o pagamento de ' + m.length + (m.length > 1 ? ' fechamentos' : ' fechamento') + ' (' + n + (n === 1 ? ' entregador' : ' entregadores') + '), total ' + f.querySelector('#sel-total').textContent + '?\n\n'
      + (linhas.length > 40 ? linhas.slice(0, 40).join('\n') + '\n  … e mais ' + (linhas.length - 40) + ' linhas' : linhas.join('\n'))
      + '\n\nConfirme só depois de fazer as transferências no banco.';
    if (!confirm(txt)) e.preventDefault();
  });
  atual();
}
document.querySelectorAll('form[data-confirma-txt]').forEach((x) => x.addEventListener('submit', (e) => { if (!confirm(x.dataset.confirmaTxt)) e.preventDefault(); }));
