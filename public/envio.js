// Destinatários do envio: lista de e-mails (chips) com adicionar e remover. O textarea "para" continua sendo o que vai no formulário.
(function () {
  const box = document.querySelector('[data-para]');
  if (!box) return;
  const ta = document.getElementById('para'), ul = box.querySelector('.para-chips'), inp = document.getElementById('para-novo');
  const err = document.getElementById('para-erro'), n = document.querySelector('[data-para-n]'), padraoBtn = document.querySelector('[data-para-padrao]');
  const form = document.getElementById('form-envio'), envio = form.querySelector('[data-envio]'), lbl = envio.querySelector('[data-rotulo]');
  const MAX = 20, ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const parte = (t) => String(t || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const padrao = parte(ta.value);
  let lista = padrao.slice();
  ta.hidden = true; ta.required = false;

  function aviso(msg) { err.hidden = !msg; err.textContent = msg || ''; }
  function render() {
    ul.textContent = '';
    lista.forEach((e) => {
      const li = document.createElement('li'); if (padrao.indexOf(e) < 0) li.className = 'novo';
      const s = document.createElement('span'); s.textContent = e;
      const b = document.createElement('button'); b.type = 'button'; b.textContent = '×'; b.title = 'Remover ' + e; b.setAttribute('aria-label', 'Remover ' + e); b.dataset.rm = e;
      li.appendChild(s); li.appendChild(b); ul.appendChild(li);
    });
    ta.value = lista.join('\n');
    n.textContent = lista.length ? '(' + lista.length + ')' : '';
    const soEmail = form.action.endsWith('/email'); envio.disabled = soEmail && !lista.length; // enviar ao financeiro vale sem e-mail; só o reenvio do e-mail exige destinatário
    lbl.textContent = lista.length ? lbl.dataset.rotulo + ' para ' + lista.length + (lista.length > 1 ? ' destinatários' : ' destinatário') : (soEmail ? lbl.dataset.rotulo : lbl.dataset.rotulo + ' (sem e-mail)');
    padraoBtn.hidden = lista.length === padrao.length && lista.every((e, i) => e === padrao[i]);
    if (!padrao.length && !lista.length) aviso(soEmail ? 'Nenhum e-mail configurado. Digite o e-mail de quem vai receber.' : 'Sem e-mail: o fechamento vai só para o financeiro, no sistema. Depois você pode reenviar o e-mail e acrescentar destinatários.');
  }
  function adiciona(txt) {
    const itens = parte(txt); let falha = '';
    itens.forEach((e) => {
      if (!ok.test(e)) falha = '"' + e + '" não parece um e-mail. Confira e tente de novo.';
      else if (lista.indexOf(e) >= 0) falha = e + ' já está na lista.';
      else if (lista.length >= MAX) falha = 'No máximo ' + MAX + ' destinatários.';
      else lista.push(e);
    });
    aviso(falha); render();
    return !falha;
  }
  function tenta() { if (!inp.value.trim()) { aviso(''); return true; } const certo = adiciona(inp.value); if (certo) inp.value = ''; else if (parte(inp.value).length === 1) { /* mantém o texto para corrigir */ } return certo; }

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') { if (inp.value.trim()) { e.preventDefault(); tenta(); } else if (e.key === 'Enter') e.preventDefault(); }
    else if (e.key === 'Backspace' && !inp.value && lista.length) { lista.pop(); aviso(''); render(); }
  });
  inp.addEventListener('paste', () => setTimeout(() => { if (parte(inp.value).length > 1) tenta(); }, 0));
  inp.addEventListener('blur', () => { if (inp.value.trim()) tenta(); });
  box.querySelector('[data-para-add]').addEventListener('click', () => { tenta(); inp.focus(); });
  ul.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; lista = lista.filter((x) => x !== b.dataset.rm); aviso(''); render(); inp.focus(); });
  padraoBtn.addEventListener('click', () => { lista = padrao.slice(); inp.value = ''; aviso(''); render(); });
  // Se sobrou algo digitado, entra na lista antes de enviar; sem destinatário, não envia.
  form.addEventListener('submit', (e) => {
    if (inp.value.trim() && !tenta()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (!lista.length && /\/email$/.test(form.action)) { e.preventDefault(); e.stopImmediatePropagation(); aviso('Adicione pelo menos um destinatário.'); inp.focus(); return; }
    // Reconfirmação: o diálogo mostra para quem vai e a justificativa digitada.
    const dp = document.querySelector('[data-dlg-para]'), dj = document.querySelector('[data-dlg-just]'), j = document.getElementById('justificativa');
    if (dp) { dp.textContent = ''; (lista.length ? lista : ['Nenhum e-mail: o fechamento chega ao financeiro só no sistema. Reenvie o e-mail depois.']).forEach((x) => { const li = document.createElement('li'); li.textContent = x; dp.appendChild(li); }); }
    if (dj && j) dj.textContent = j.value.trim();
  }, true);
  render();
})();
