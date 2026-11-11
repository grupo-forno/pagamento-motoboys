// Filtra a lista pelo texto digitado.
document.querySelectorAll('[data-busca]').forEach((i) => i.addEventListener('input', () => {
  const q = i.value.trim().toLowerCase(), itens = [...document.querySelectorAll(i.dataset.busca)];
  itens.forEach((el) => { el.hidden = !!q && !(el.querySelector('summary') || el).textContent.toLowerCase().includes(q); });
  const vazio = document.getElementById('vazio-busca'); if (vazio) vazio.hidden = itens.some((el) => !el.hidden);
}));

// "Ver na agenda": abre a agenda recolhível antes de rolar até ela.
function abreAgenda() { if (location.hash === '#agenda') { const d = document.getElementById('agenda-rec'); if (d) d.open = true; } }
abreAgenda(); addEventListener('hashchange', abreAgenda);

// ---- Usuários: filtros (guardados na sessão), escopo do perfil, alterações não salvas e painel reaberto com erro ----
(function () {
  const fil = document.querySelector('[data-filtro-u]');
  if (fil) {
    const chave = 'admin-usuarios', campos = [...fil.querySelectorAll('[data-f]')], linhas = [...document.querySelectorAll('tr[data-u]')], vazio = document.getElementById('vazio-u'), conta = document.getElementById('u-conta');
    const aplica = () => {
      const q = campos[0].value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), perfil = campos[1].value, ativo = campos[2].value;
      let n = 0;
      linhas.forEach((tr) => { const ok = (!q || tr.dataset.texto.includes(q)) && (!perfil || tr.dataset.perfil === perfil) && (!ativo || tr.dataset.ativo === ativo); tr.hidden = !ok; if (ok) n++; });
      vazio.hidden = n > 0; conta.textContent = n === linhas.length ? n : n + ' de ' + linhas.length;
      try { sessionStorage.setItem(chave, JSON.stringify(campos.map((c) => c.value))); } catch (_) {}
    };
    try { const s = JSON.parse(sessionStorage.getItem(chave) || 'null'); if (s) campos.forEach((c, i) => { c.value = s[i] || ''; }); } catch (_) {}
    campos.forEach((c) => c.addEventListener('input', aplica));
    document.querySelectorAll('[data-limpar-u]').forEach((b) => b.addEventListener('click', () => { campos.forEach((c) => { c.value = ''; }); aplica(); campos[0].focus(); }));
    aplica();
    try { const y = sessionStorage.getItem(chave + '-y'); if (y && !document.querySelector('dialog[data-abrir]')) requestAnimationFrame(() => scrollTo(0, +y)); } catch (_) {}
    addEventListener('pagehide', () => { try { sessionStorage.setItem(chave + '-y', scrollY); } catch (_) {} });
  }
  let sujo = false;
  document.querySelectorAll('form[data-escopo-form]').forEach((f) => {
    const perfil = f.querySelector('[data-perfil]'), loja = f.querySelector('[data-loja]'), box = f.querySelector('[data-escopo] span'), tx = JSON.parse(document.getElementById('escopos').textContent);
    const atualiza = () => {
      const p = perfil.value, com = ['despachante', 'financeiro'].includes(p), nome = loja.selectedOptions[0] && loja.value ? loja.selectedOptions[0].text : '';
      loja.disabled = !com; loja.required = p === 'despachante'; if (!com) loja.value = '';
      loja.options[0].text = p === 'despachante' ? 'Escolha a loja…' : 'Todas as lojas';
      box.textContent = (tx[p + (nome ? '' : 'Sem')] || tx[p] || '').replace('{loja}', nome);
    };
    perfil.addEventListener('change', atualiza); loja.addEventListener('change', atualiza); atualiza();
    f.addEventListener('input', () => { f.dataset.sujo = '1'; }); f.addEventListener('change', () => { f.dataset.sujo = '1'; });
  });
  // Fechar (botão ou Esc) com alterações não salvas pede confirmação; salvar libera.
  document.querySelectorAll('dialog form[data-guarda]').forEach((f) => {
    const d = f.closest('dialog'), msg = 'Há alterações não salvas. Descartar e fechar?';
    d.addEventListener('cancel', (e) => { if (f.dataset.sujo && !confirm(msg)) e.preventDefault(); });
    f.addEventListener('submit', () => { f.dataset.sujo = ''; sujo = false; });
    d.addEventListener('click', (e) => { if (e.target.closest('[data-fecha]') && f.dataset.sujo && !confirm(msg)) e.stopImmediatePropagation(); }, true);
    d.addEventListener('close', () => { if (!d.dataset.reabriu) f.dataset.sujo = ''; });
  });
  addEventListener('beforeunload', (e) => { if ([...document.querySelectorAll('form[data-guarda]')].some((f) => f.dataset.sujo)) { e.preventDefault(); e.returnValue = ''; } });
  const reaberto = document.querySelector('dialog[data-abrir]');
  if (reaberto) { reaberto.showModal(); reaberto.querySelector('form').dataset.sujo = '1'; const c = reaberto.querySelector('[aria-invalid="true"]') || reaberto.querySelector('input,select'); if (c) c.focus(); }
})();

// ---- Configurações: alterações não salvas em formulários de página, exemplos de calendário ----
document.querySelectorAll('form[data-guarda]:not([data-escopo-form])').forEach((f) => {
  const marca = () => { f.dataset.sujo = '1'; };
  f.addEventListener('input', marca); f.addEventListener('change', marca); f.addEventListener('submit', () => { f.dataset.sujo = ''; });
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cal-ex]'); if (!b) return;
  const campo = b.closest('form').querySelector('input[name=calendario]'); campo.value = b.dataset.calEx; campo.dispatchEvent(new Event('input', { bubbles: true })); campo.focus();
});
