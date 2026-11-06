// Tela de conferência (financeiro): filtros, seleção, rodapé com escopo, "Por dia", detalhe e confirmação.
// Tabela, lista do celular e detalhe leem o mesmo objeto (#fc-dados), então mostram os mesmos valores.
(function () {
  const fc = document.getElementById('fc');
  if (!fc) return;
  const D = JSON.parse(document.getElementById('fc-dados').textContent), porId = {};
  D.itens.forEach((i) => { porId[i.id] = i; });
  const NB = ' ';
  const brl = (c) => (c < 0 ? '-' : '') + 'R$' + NB + (Math.abs(c) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sinal = (c) => (c > 0 ? '+' : '') + brl(c);
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const $ = (id) => document.getElementById(id);
  const q = $('fc-q'), seg = $('fc-seg'), fb = $('fc-filtros-btn'), nfl = fc.querySelector('[data-fc-nfiltros]');
  const tR = $('fc-resumo'), tD = $('fc-dia'), fm = $('dec'), todos = $('sel-todos'), selDia = $('dia-sel');
  const rowsR = [].slice.call(tR.querySelectorAll('tbody tr')), rowsD = [].slice.call(tD.querySelectorAll('tbody tr'));
  const semanas = D.dias.length ? D.dias[D.dias.length - 1].sem + 1 : 1;
  const KEY = 'fc:' + location.pathname;
  const st = { q: '', f: 'todos', sem: 0, dia: D.dias.length ? D.dias[0].d : '' };
  try { Object.assign(st, JSON.parse(sessionStorage.getItem(KEY) || '{}')); } catch (e) { /* sem armazenamento */ }
  const salva = () => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ok */ } };
  const el = (tag, cls, txt) => { const x = document.createElement(tag); if (cls) x.className = cls; if (txt != null) x.textContent = txt; return x; };

  // ---- largura do painel
  const mede = () => {
    const w = fc.clientWidth, m = w < 640 ? 'estreito' : w < 960 ? 'curto' : w < 1200 ? 'medio' : 'largo';
    if (fc.dataset.w !== m) { fc.dataset.w = m; aplicaDias(); totais(); }
  };

  // ---- dias visíveis na grade "Por dia"
  function diasVisiveis() {
    if (fc.dataset.w === 'estreito') return [st.dia];
    return semanas > 1 ? D.dias.filter((x) => x.sem === Number(st.sem)).map((x) => x.d) : D.dias.map((x) => x.d);
  }
  function aplicaDias() {
    const vis = diasVisiveis();
    tD.querySelectorAll('.dcol').forEach((c) => c.classList.toggle('dia-off', vis.indexOf(c.dataset.d) < 0));
    rowsD.forEach((r) => {
      let t = 0;
      r.querySelectorAll('.dcol').forEach((c) => { if (!c.classList.contains('dia-off')) t += Number(c.dataset.v); });
      r.querySelector('[data-int]').textContent = brl(t);
    });
  }

  // ---- filtros
  const ativo = () => !!norm(st.q.trim()) || st.f !== 'todos';
  function filtra() {
    const nq = norm(st.q.trim());
    [rowsR, rowsD].forEach((rows) => rows.forEach((r) => {
      const okq = !nq || r.dataset.q.indexOf(nq) >= 0;
      const okf = st.f === 'todos' || (' ' + r.dataset.sit + ' ').indexOf(' ' + st.f + ' ') >= 0;
      r.classList.toggle('fora', !(okq && okf));
    }));
    // Quem sumiu da lista deixa de estar selecionado: ninguém é aprovado ou devolvido sem aparecer na tela.
    caixas().forEach((c) => { if (c.closest('tr').classList.contains('fora')) c.checked = false; });
    seg.querySelectorAll('button').forEach((b) => { const on = b.dataset.f === st.f; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    nfl.textContent = st.f !== 'todos' ? '1' : '0';
    aplicaDias(); totais(); atualiza(); salva();
  }
  function totais() {
    const filtrado = ativo(), n = rowsR.filter((r) => !r.classList.contains('fora')).length, m = rowsR.length;
    let base = 0, aj = 0, tot = 0;
    rowsR.forEach((r) => { if (!r.classList.contains('fora')) { base += Number(r.dataset.base); aj += Number(r.dataset.aj); tot += Number(r.dataset.valor); } });
    const fR = tR.tFoot;
    fR.querySelector('[data-t=base]').textContent = brl(base);
    fR.querySelector('[data-t=aj]').textContent = brl(aj);
    fR.querySelector('[data-t=tot]').textContent = brl(tot);
    fR.querySelector('[data-esc]').textContent = filtrado ? 'Total dos resultados filtrados' : 'Total do fechamento';
    fR.querySelector('[data-esc-n]').textContent = filtrado ? n + ' de ' + m + ' entregadores' : m + ' entregadores';
    // Por dia: soma só das linhas visíveis e dos dias visíveis.
    const vis = diasVisiveis(), somaDia = {};
    rowsD.forEach((r) => { if (!r.classList.contains('fora')) r.querySelectorAll('.dcol').forEach((c) => { somaDia[c.dataset.d] = (somaDia[c.dataset.d] || 0) + Number(c.dataset.v); }); });
    let ti = 0;
    tD.tFoot.querySelectorAll('[data-tdia]').forEach((c) => { const v = somaDia[c.dataset.tdia] || 0; c.textContent = brl(v); if (vis.indexOf(c.dataset.tdia) >= 0) ti += v; });
    tD.tFoot.querySelector('[data-tint]').textContent = brl(ti);
    const rot = (d) => (D.dias.filter((x) => x.d === d)[0] || {}).rot || '';
    const faixa = vis.length > 1 ? rot(vis[0]).slice(0, 5) + ' a ' + rot(vis[vis.length - 1]).slice(0, 5) : rot(vis[0]);
    tD.tFoot.querySelector('[data-esc]').textContent = filtrado ? 'Total dos resultados filtrados' : 'Total do intervalo';
    tD.tFoot.querySelector('[data-esc-n]').textContent = faixa + ' · ' + (filtrado ? n + ' de ' + m : m) + ' entregadores';
    fc.querySelectorAll('[data-vazio]').forEach((p) => { p.hidden = n > 0; });
  }
  const limpaFiltros = () => { st.q = ''; st.f = 'todos'; q.value = ''; filtra(); };

  q.addEventListener('input', () => { st.q = q.value; filtra(); });
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    st.f = b.dataset.f; seg.classList.remove('aberto'); fb.setAttribute('aria-expanded', 'false'); filtra();
  });
  fb.addEventListener('click', () => { const a = seg.classList.toggle('aberto'); fb.setAttribute('aria-expanded', a); if (a) { const b = seg.querySelector('button'); if (b) b.focus(); } });
  fc.addEventListener('click', (e) => { if (e.target.closest('[data-limpar-filtros]')) limpaFiltros(); });
  const chips = fc.querySelector('.dia-sem');
  if (chips) chips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sem]'); if (!b) return;
    st.sem = Number(b.dataset.sem);
    chips.querySelectorAll('button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
    aplicaDias(); totais(); salva();
  });
  selDia.addEventListener('change', () => { st.dia = selDia.value; aplicaDias(); totais(); salva(); });

  // ---- seleção
  const caixas = () => [].slice.call(tR.querySelectorAll('tbody input[name=m]'));
  const sel = () => caixas().filter((c) => c.checked);
  const bar = fm.querySelector('.barra');
  const n = bar && bar.querySelector('[data-sel-n]'), v = bar && bar.querySelector('[data-sel-v]'), bl = bar && bar.querySelector('[data-sel-bloq]');
  const bA = bar && bar.querySelector('[data-dec=aprovar]'), bD = bar && bar.querySelector('[data-dec=devolver]'), bL = bar && bar.querySelector('[data-limpar]');
  const rotDev = bar && bar.querySelector('[data-rot-dev]'), rotApr = bar && bar.querySelector('[data-rot-apr]');
  function atualiza() {
    if (!bar) return;
    const s = sel(); let tot = 0;
    s.forEach((c) => { tot += Number(c.closest('tr').dataset.valor); });
    const marc = s.map((c) => Number(c.value)), faltaObrig = obrig.filter((i) => marc.indexOf(i.id) < 0), nDev = s.length + faltaObrig.length;
    n.textContent = s.length ? s.length + (s.length > 1 ? ' entregadores marcados para devolver' : ' entregador marcado para devolver') + ' · soma' : 'Nenhum entregador marcado para devolver';
    v.textContent = brl(tot);
    rotDev.textContent = nDev ? 'Devolver ' + nDev : 'Devolver';
    rotApr.textContent = 'Aprovar todos · ' + brl(soma(pend));
    bD.disabled = !nDev; bL.disabled = !s.length;
    bA.disabled = !pend.length || s.length > 0 || obrig.length > 0;
    bA.title = s.length ? 'Você marcou entregadores para devolver: use Devolver (os demais são aprovados junto).' : obrig.length ? 'Há entregadores sem chave PIX: devolva-os à loja.' : '';
    bl.hidden = !obrig.length;
    bl.textContent = obrig.length ? plural(obrig.length, 'entregador sem chave PIX não pode', 'entregadores sem chave PIX não podem') + ' ser aprovado' + (obrig.length > 1 ? 's' : '') + ': será devolvido à loja.' : '';
    const vc = caixas().filter((c) => !c.closest('tr').classList.contains('fora'));
    if (todos) { todos.disabled = !vc.length; todos.checked = vc.length > 0 && vc.every((c) => c.checked); todos.indeterminate = !todos.checked && vc.some((c) => c.checked); }
  }
  fm.addEventListener('change', (e) => {
    if (e.target === todos) caixas().forEach((c) => { if (!c.closest('tr').classList.contains('fora')) c.checked = todos.checked; });
    atualiza();
  });
  if (bL) bL.addEventListener('click', () => { caixas().forEach((c) => { c.checked = false; }); atualiza(); });

  // ---- decisão: aprovar tudo, ou devolver os marcados (cada um com seu motivo) e aprovar automaticamente os demais
  const dlg = $('dlg-dec');
  const pend = D.itens.filter((i) => i.pode && i.total > 0), obrig = pend.filter((i) => i.bloq);
  let quem = null, ids = [];
  const soma = (l) => l.reduce((s, i) => s + i.total, 0);
  const plural = (k, um, varios) => k + ' ' + (k === 1 ? um : varios);
  const marcados = () => sel().map((c) => Number(c.value));
  const idsDevolver = () => { const s = marcados(); obrig.forEach((i) => { if (s.indexOf(i.id) < 0) s.push(i.id); }); return s; };
  const limpaCampos = () => { fm.querySelectorAll('input[name=dev]').forEach((x) => x.remove()); };
  const t = $('dlg-dec-t'), r = $('dlg-dec-r'), av = dlg.querySelector('[data-dec-aviso]'), avp = av.querySelector('p'), ul = dlg.querySelector('[data-dlg-lista]'), hint = dlg.querySelector('[data-dlg-hint]');
  const bOk = dlg.querySelector('[data-dlg-ok]'), bProx = dlg.querySelector('[data-dlg-prox]'), bVolta = dlg.querySelector('[data-dlg-volta]');
  const abre = () => { if (!dlg.open) { quem = document.activeElement; dlg.showModal(); } };
  const autoTxt = () => {
    const auto = pend.filter((i) => ids.indexOf(i.id) < 0);
    return auto.length ? (auto.length === 1 ? 'O entregador que você não marcou será aprovado automaticamente' : 'Os ' + auto.length + ' entregadores que você não marcou serão aprovados automaticamente') + ' (' + brl(soma(auto)) + ').'
      : 'Nenhum entregador será aprovado: o fechamento inteiro volta à loja.';
  };
  function vista(p) {
    r.classList.remove('erro-t');
    ul.hidden = p !== 1; hint.hidden = p !== 1; bProx.hidden = p !== 1; bVolta.hidden = p !== 2; bOk.hidden = p !== 2;
    const its = ids.map((id) => porId[id]);
    if (p === 1) {
      t.textContent = 'Devolver ' + plural(its.length, 'entregador', 'entregadores') + ' à loja';
      r.textContent = 'Escreva o motivo de cada devolução. A loja vê o motivo de cada entregador.';
      avp.textContent = autoTxt();
    } else {
      t.textContent = 'Confirmar decisão';
      r.textContent = 'Você vai devolver ' + plural(its.length, 'entregador', 'entregadores') + ' (' + brl(soma(its)) + ') à loja.';
      avp.textContent = 'Atenção: ' + autoTxt().replace(/^O /, 'o ').replace(/^Os /, 'os ');
      bOk.className = 'btn btn-pri'; bOk.textContent = 'Confirmar e devolver';
      limpaCampos();
      ids.forEach((id) => { const h = document.createElement('input'); h.type = 'hidden'; h.name = 'dev'; h.value = id; fm.appendChild(h); });
    }
  }
  function passoAprovar() {
    ids = []; limpaCampos();
    t.textContent = 'Aprovar o fechamento';
    r.textContent = 'Você vai aprovar ' + plural(pend.length, 'entregador', 'entregadores') + ', total de ' + brl(soma(pend)) + '. O fechamento fica aprovado e passa para Pagamentos.';
    av.hidden = true; ul.hidden = true; hint.hidden = true; bProx.hidden = true; bVolta.hidden = true; bOk.hidden = false;
    bOk.className = 'btn btn-ok'; bOk.textContent = 'Aprovar ' + brl(soma(pend));
    abre(); bOk.focus();
  }
  function passoMotivos() {
    ids = idsDevolver(); limpaCampos();
    ul.textContent = '';
    ids.map((id) => porId[id]).forEach((i) => {
      const li = el('li', 'dec-item'), h = el('div', 'dec-nome');
      h.appendChild(el('b', '', i.nome)); h.appendChild(el('span', 'mut', '· ' + brl(i.total)));
      if (i.bloq) h.appendChild(el('span', 'badge bad', i.bloq));
      const lb = el('label', '', 'Motivo da devolução'); lb.htmlFor = 'mot-' + i.id; lb.appendChild(el('span', 'req', ' *'));
      const ta = el('textarea'); ta.id = 'mot-' + i.id; ta.name = 'motivo_' + i.id; ta.required = true; ta.minLength = 5; ta.maxLength = 2000; ta.rows = 2;
      li.appendChild(h); li.appendChild(lb); li.appendChild(ta); ul.appendChild(li);
    });
    av.hidden = false; vista(1); abre();
    const primeiro = ul.querySelector('textarea'); if (primeiro) primeiro.focus();
  }
  function passoConfirma() {
    const ruim = [].slice.call(ul.querySelectorAll('textarea')).filter((x) => x.value.trim().length < 5);
    if (ruim.length) { r.textContent = 'Escreva o motivo de cada entregador (mínimo 5 caracteres).'; r.classList.add('erro-t'); ruim[0].focus(); return; }
    vista(2);
  }
  if (bar) {
    bA.addEventListener('click', (e) => { e.preventDefault(); passoAprovar(); });
    bD.addEventListener('click', (e) => { e.preventDefault(); passoMotivos(); });
    bProx.addEventListener('click', passoConfirma);
    bVolta.addEventListener('click', () => vista(1));
    dlg.querySelector('[data-dlg-cancela]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { limpaCampos(); if (quem) quem.focus(); });
  }

  // ---- detalhe do entregador (mesmos dados da tabela)
  const dd = $('dlg-det'), corpo = $('det-corpo'), acoes = $('det-acoes');
  let opener = null;
  function abreDet(id) {
    const i = porId[id]; if (!i) return;
    opener = document.activeElement;
    $('det-t').textContent = i.nome;
    const sit = $('det-sit'); sit.className = 'badge ' + i.sitCor; sit.textContent = i.sitTxt;
    corpo.textContent = '';
    if (i.det) corpo.appendChild(el('p', 'small det-sec', i.det));
    const sp = el('div', 'det-sec det-pixbox'); sp.appendChild(el('h3', '', 'Chave PIX'));
    if (i.pix) {
      const p = el('div', 'det-pix'); p.appendChild(el('span', '', i.pix));
      const cp = el('button', 'btn btn-sec btn-sm', 'Copiar'); cp.type = 'button'; cp.dataset.copiar = i.pix; cp.title = 'Copiar chave PIX'; cp.setAttribute('aria-label', 'Copiar chave PIX de ' + i.nome); p.appendChild(cp); sp.appendChild(p);
    } else sp.appendChild(el('span', 'badge bad', 'Sem chave PIX'));
    if (i.aviso) sp.appendChild(el('p', 'small warn-t', i.aviso));
    corpo.appendChild(sp);
    const sv = el('div', 'det-sec'); sv.appendChild(el('h3', '', 'Valores'));
    const dl = el('dl', 'det');
    const lin = (k, val, cls) => { dl.appendChild(el('dt', cls || '', k)); dl.appendChild(el('dd', cls || '', val)); };
    lin('Valor base', brl(i.bruto));
    if (D.temResumo) {
      lin('Resumo do Agilizone (soma das taxas)', i.noResumo ? 'não consta' : brl(i.resumo));
      lin('Conferência dos valores por dia', i.noResumo ? '—' : i.dif === 0 ? 'Valores conferem' : 'Difere ' + sinal(i.dif));
    }
    if (i.oc || i.qtdOc) lin('Ocorrências do Agilizone (' + i.qtdOc + ')', sinal(i.oc));
    if (i.pago) lin('Já pago no Agilizone', '-' + brl(i.pago));
    lin('Total do fechamento', brl(i.total), 'total');
    sv.appendChild(dl); corpo.appendChild(sv);
    const sd = el('div', 'det-sec'); sd.appendChild(el('h3', '', 'Valores por dia'));
    const ul = el('ul', 'det-dias'); let vazios = 0;
    D.dias.forEach((x, k) => {
      const c = i.dias[k]; if (!c) { vazios++; return; }
      const li = el('li'); li.appendChild(el('span', '', x.rot)); li.appendChild(el('span', '', c[1] + ' entrega' + (c[1] === 1 ? '' : 's'))); li.appendChild(el('span', '', brl(c[0]))); ul.appendChild(li);
    });
    sd.appendChild(ul); if (vazios) sd.appendChild(el('p', 'small mut', vazios + ' dia(s) sem entregas.')); corpo.appendChild(sd);
    acoes.textContent = '';
    if (D.decide && i.pode) {
      const cx = tR.querySelector('input[name=m][value="' + i.id + '"]');
      if (!i.bloq && cx) { const mk = el('button', 'btn ' + (cx.checked ? 'btn-pri' : 'btn-sec'), cx.checked ? 'Desmarcar devolução' : 'Marcar para devolver'); mk.type = 'button'; mk.dataset.dact = 'marcar'; acoes.appendChild(mk); }
    }
    if (D.edit) { const ed = el('a', 'btn btn-sec', 'Editar nome e PIX'); ed.href = D.edit + i.id; acoes.appendChild(ed); }
    const fe = el('button', 'btn btn-ghost', 'Fechar'); fe.type = 'button'; fe.dataset.detFecha = ''; acoes.appendChild(fe);
    dd.dataset.id = id; dd.showModal();
  }
  fc.addEventListener('click', (e) => {
    const b = e.target.closest('[data-det]');
    if (b) { abreDet(Number(b.dataset.det)); return; }
    const tr = e.target.closest('tbody tr');
    if (tr && tr.closest('.fc-t') && !e.target.closest('a,button,input,label,select,textarea')) { const x = tr.querySelector('[data-det]'); if (x) abreDet(Number(x.dataset.det)); }
  });
  dd.addEventListener('click', (e) => {
    if (e.target.closest('[data-det-fecha]') || e.target === dd) { dd.close(); return; }
    const a = e.target.closest('[data-dact]');
    if (a && bar) { const cx = tR.querySelector('input[name=m][value="' + dd.dataset.id + '"]'); if (cx) { cx.checked = !cx.checked; cx.dispatchEvent(new Event('change', { bubbles: true })); } dd.close(); }
  });
  dd.addEventListener('close', () => { if (opener && document.contains(opener)) opener.focus(); });

  // ---- início
  q.value = st.q || '';
  if (chips) chips.querySelectorAll('button').forEach((x) => { const on = Number(x.dataset.sem) === Number(st.sem); x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
  if (D.dias.some((x) => x.d === st.dia)) selDia.value = st.dia; else st.dia = selDia.value;
  new ResizeObserver(mede).observe(fc);
  mede(); filtra();
})();
