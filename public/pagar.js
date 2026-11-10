// Pagamentos: confirmação explícita e consulta do estado após resposta incerta.
(() => {
  const form = document.querySelector('form[data-pagar]');
  if (!form) return;
  const brl = (valor) => (valor / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const caixas = [...form.querySelectorAll('input[name=sel]')];
  const todos = form.querySelector('[data-todos]'), botao = form.querySelector('[data-pagar-btn]');
  const modal = document.getElementById('dlg-pagamento');
  const confirmar = modal.querySelector('[data-pg-confirmar]'), cancelar = modal.querySelector('[data-pg-cancelar]');
  const consultar = modal.querySelector('[data-pg-consultar]'), atualizarFila = modal.querySelector('[data-pg-atualizar]');
  const resumo = modal.querySelector('[data-pg-resumo]'), status = modal.querySelector('[data-pg-status]');
  const chave = 'pagamento-pendente:' + form.dataset.usuario;
  let selecao = [], enviando = false, pendente = false, origem;
  const marcados = () => caixas.filter((c) => c.checked);
  const guardar = () => { try { sessionStorage.setItem(chave, JSON.stringify(selecao)); } catch (_) {} };
  const esquecer = () => { try { sessionStorage.removeItem(chave); } catch (_) {} };
  function atualizar() {
    if (!botao) return;
    const sel = marcados(), quantidade = sel.reduce((n, c) => n + Number(c.dataset.n), 0);
    form.querySelector('#sel-rot').textContent = sel.length ? `${sel.length} fechamento(s) · ${quantidade} entregador(es)` : 'Nenhum fechamento selecionado';
    form.querySelector('#sel-total').textContent = brl(sel.reduce((n, c) => n + Number(c.dataset.v), 0));
    botao.disabled = enviando || pendente || !sel.length;
    if (todos) { todos.checked = !!caixas.length && sel.length === caixas.length; todos.indeterminate = !!sel.length && !todos.checked; }
  }
  function abrir() {
    origem = document.activeElement;
    if (!modal.open) modal.showModal();
  }
  function mostrarSelecao() {
    resumo.replaceChildren();
    const ul = document.createElement('ul'); ul.className = 'pg-confirmar-lista';
    selecao.forEach((item) => { const li = document.createElement('li'); li.textContent = item.rotulo + ' · ' + brl(item.valor); ul.appendChild(li); });
    resumo.appendChild(ul);
    modal.querySelector('[data-pg-total]').textContent = `${selecao.length} fechamento(s) · total ${brl(selecao.reduce((n, item) => n + item.valor, 0))}`;
  }
  async function estadoRegistrado() {
    if (enviando) return;
    enviando = true; pendente = true; atualizar();
    confirmar.hidden = true; consultar.hidden = true; atualizarFila.hidden = true; cancelar.hidden = true;
    status.textContent = 'Consultando o estado registrado…';
    try {
      const ids = selecao.map((item) => item.id);
      const response = await fetch('/pagar/estado?ids=' + encodeURIComponent(ids.join(',')), { cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('Consulta indisponível');
      const dados = await response.json();
      if (!Array.isArray(dados.fechamentos) || dados.fechamentos.length !== ids.length || !dados.fechamentos.every((f) => ids.includes(f.id))) throw Error('Resposta incompleta');
      const concluidos = dados.fechamentos.filter((f) => f.registrado);
      resumo.replaceChildren();
      const ul = document.createElement('ul'); ul.className = 'pg-confirmar-lista';
      dados.fechamentos.forEach((f) => {
        const li = document.createElement('li');
        li.textContent = `#${f.id} · ${f.loja} · ${brl(f.valor)} · ` + (f.registrado ? `registrado${f.lote ? ' no lote #' + f.lote : ''}` : 'sem registro de pagamento');
        ul.appendChild(li);
      });
      resumo.appendChild(ul);
      status.textContent = `${concluidos.length} de ${dados.fechamentos.length} registro(s) confirmado(s) no sistema. ` + (concluidos.length === dados.fechamentos.length ? 'Os pagamentos constam como registrados. Atualize a fila.' : 'Confira os itens acima e atualize a fila antes de selecionar novamente.');
      // Não reenvia a mesma seleção. Uma nova tentativa sempre parte da fila atualizada.
      esquecer(); atualizarFila.hidden = false; atualizarFila.focus();
    } catch (_) {
      status.textContent = 'Não foi possível consultar o estado. O resultado do envio ainda é incerto. Consulte novamente antes de tentar registrar outro pagamento.';
      consultar.hidden = false; consultar.focus();
    } finally { enviando = false; atualizar(); }
  }
  caixas.forEach((c) => c.addEventListener('change', atualizar));
  todos?.addEventListener('change', () => { caixas.forEach((c) => { c.checked = todos.checked; }); atualizar(); });
  form.querySelector('[data-limpar]')?.addEventListener('click', () => { caixas.forEach((c) => { c.checked = false; }); atualizar(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (enviando || pendente || !marcados().length) return;
    selecao = marcados().map((c) => ({ id: Number(c.value.split(':')[0]), token: c.value, rotulo: c.dataset.rot, valor: Number(c.dataset.v) }));
    mostrarSelecao(); status.textContent = ''; confirmar.hidden = false; confirmar.disabled = false; cancelar.hidden = false; consultar.hidden = true; atualizarFila.hidden = true;
    abrir(); cancelar.focus();
  });
  confirmar.addEventListener('click', async () => {
    if (enviando || pendente || !selecao.length) return;
    // Persiste a intenção antes do envio para que recarregar também consulte o estado.
    guardar(); pendente = true; enviando = true; atualizar();
    confirmar.disabled = true; cancelar.hidden = true;
    modal.setAttribute('aria-busy', 'true');
    status.textContent = 'Registrando o pagamento… Aguarde a confirmação.';
    const body = new URLSearchParams({ volta: form.elements.volta.value });
    selecao.forEach((item) => body.append('sel', item.token));
    try {
      const response = await fetch(form.action, { method: 'POST', body, signal: AbortSignal.timeout(20000) });
      const url = new URL(response.url);
      if (response.ok && response.redirected && url.origin === location.origin && url.pathname === '/pagar' && (url.searchParams.has('ok') || url.searchParams.has('erro'))) {
        esquecer(); location.assign(url.href); return;
      }
      throw Error('Resposta sem confirmação');
    } catch (_) {
      enviando = false;
      await estadoRegistrado();
    } finally { enviando = false; modal.removeAttribute('aria-busy'); atualizar(); }
  });
  consultar.addEventListener('click', estadoRegistrado);
  modal.addEventListener('cancel', (e) => { if (enviando || pendente) e.preventDefault(); });
  modal.addEventListener('close', () => { if (!pendente && origem) origem.focus(); });
  try {
    const salva = JSON.parse(sessionStorage.getItem(chave) || 'null');
    if (Array.isArray(salva) && salva.length && salva.every((item) => Number.isSafeInteger(item.id))) {
      selecao = salva; pendente = true; mostrarSelecao(); abrir(); estadoRegistrado();
    }
  } catch (_) { esquecer(); }
  atualizar();
})();
// Desfazer mantém a regra atual e exige confirmação separada.
document.querySelectorAll('form[data-confirma-txt]').forEach((form) => form.addEventListener('submit', (e) => { if (!confirm(form.dataset.confirmaTxt)) e.preventDefault(); }));
