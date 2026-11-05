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
  function atualiza() {
    if (!bar) return;
    const s = sel(); let tot = 0, bq = 0;
    s.forEach((c) => { const r = c.closest('tr'); tot += Number(r.dataset.valor); if (r.dataset.bloq) bq++; });
    n.textContent = s.length ? s.length + (s.length > 1 ? ' entregadores selecionados' : ' entregador selecionado') + ' · soma' : 'Nenhum entregador selecionado';
    v.textContent = brl(tot);
    bA.disabled = !s.length || bq > 0; bD.disabled = !s.length; bL.disabled = !s.length;
    bl.hidden = !bq; bl.textContent = bq ? bq + ' selecionado(s) não pode(m) ser aprovado(s): veja a situação na linha.' : '';
    const vc = caixas().filter((c) => !c.closest('tr').classList.contains('fora'));
    if (todos) { todos.disabled = !vc.length; todos.checked = vc.length > 0 && vc.every((c) => c.checked); todos.indeterminate = !todos.checked && vc.some((c) => c.checked); }
  }
  fm.addEventListener('change', (e) => {
    if (e.target === todos) caixas().forEach((c) => { if (!c.closest('tr').classList.contains('fora')) c.checked = todos.checked; });
    atualiza();
  });
  if (bL) bL.addEventListener('click', () => { caixas().forEach((c) => { c.checked = false; }); atualiza(); });

  // ---- confirmação de aprovar/devolver
  const dlg = $('dlg-dec'), uma = fm.querySelector('input[type=hidden][name=uma]');
  let quem = null;
  function abreDec(a, ids) {
    quem = document.activeElement;
    const its = ids.map((id) => porId[id]), tot = its.reduce((s, i) => s + i.total, 0);
    fm.action = fm.dataset[a];
    $('dlg-dec-t').textContent = a === 'aprovar' ? 'Aprovar pagamento' : 'Devolver à loja para correção';
    $('dlg-dec-r').textContent = (a === 'aprovar' ? 'Você vai aprovar ' : 'Você vai devolver ') + ids.length + (ids.length > 1 ? ' entregadores' : ' entregador') + ', total de ' + brl(tot) + '.';
    const ul = dlg.querySelector('[data-dlg-lista]'); ul.textContent = '';
    its.forEach((i) => ul.appendChild(el('li', '', i.nome + ' · ' + brl(i.total))));
    const mo = dlg.querySelector('[data-dlg-motivo]'), ta = mo.querySelector('textarea'), ok = dlg.querySelector('[data-dlg-ok]');
    mo.hidden = a !== 'devolver'; ta.required = a === 'devolver';
    ok.textContent = a === 'aprovar' ? 'Aprovar ' + brl(tot) : 'Devolver ' + brl(tot) + ' à loja';
    ok.className = 'btn ' + (a === 'aprovar' ? 'btn-ok' : 'btn-pri');
    dlg.showModal(); (a === 'devolver' ? ta : ok).focus();
  }
  if (bar) {
    [bA, bD].forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); uma.value = ''; abreDec(b.dataset.dec, sel().map((c) => Number(c.value))); }));
    tR.addEventListener('click', (e) => {
      const b = e.target.closest('[data-linha]'); if (!b) return;
      e.preventDefault(); uma.value = b.dataset.id; abreDec(b.dataset.linha, [Number(b.dataset.id)]);
    });
    dlg.querySelector('[data-dlg-cancela]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { uma.value = ''; if (quem) quem.focus(); });
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
    const sp = el('div', 'det-sec'); sp.appendChild(el('h3', '', 'Chave PIX'));
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
    if (i.oc || i.qtdOc) lin('Ocorrências do Agilizone (' + i.qtdOc + ')', sinal(i.oc));
    if (i.pago) lin('Já pago no Agilizone', '-' + brl(i.pago));
    lin('Total do fechamento', brl(i.total), 'total');
    if (D.temResumo) {
      lin('Resumo do Agilizone (soma das taxas)', i.noResumo ? 'não consta' : brl(i.resumo));
      lin('Diferença com a soma dos dias', i.noResumo ? '—' : i.dif === 0 ? 'bate' : sinal(i.dif));
    }
    sv.appendChild(dl); corpo.appendChild(sv);
    const sd = el('div', 'det-sec'); sd.appendChild(el('h3', '', 'Valores por dia (período completo)'));
    const ul = el('ul', 'det-dias'); let vazios = 0;
    D.dias.forEach((x, k) => {
      const c = i.dias[k]; if (!c) { vazios++; return; }
      const li = el('li'); li.appendChild(el('span', '', x.rot)); const r = el('span', '', brl(c[0])); r.appendChild(el('small', '', ' · ' + c[1] + ' entrega(s)')); li.appendChild(r); ul.appendChild(li);
    });
    sd.appendChild(ul); if (vazios) sd.appendChild(el('p', 'small mut', vazios + ' dia(s) sem entregas.')); corpo.appendChild(sd);
    acoes.textContent = '';
    if (D.decide && i.pode) {
      const ap = el('button', 'btn btn-ok', 'Aprovar ' + brl(i.total)); ap.type = 'button'; ap.disabled = !!i.bloq; ap.dataset.dact = 'aprovar'; acoes.appendChild(ap);
      const dv = el('button', 'btn btn-sec', 'Devolver à loja'); dv.type = 'button'; dv.dataset.dact = 'devolver'; acoes.appendChild(dv);
      if (i.bloq) acoes.appendChild(el('p', 'small bad-t', 'Não pode ser aprovado: ' + i.bloq + '.'));
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
    if (a && bar) { const id = Number(dd.dataset.id); dd.close(); uma.value = String(id); abreDec(a.dataset.dact, [id]); }
  });
  dd.addEventListener('close', () => { if (opener && document.contains(opener)) opener.focus(); });

  // ---- início
  q.value = st.q || '';
  if (chips) chips.querySelectorAll('button').forEach((x) => { const on = Number(x.dataset.sem) === Number(st.sem); x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
  if (D.dias.some((x) => x.d === st.dia)) selDia.value = st.dia; else st.dia = selDia.value;
  new ResizeObserver(mede).observe(fc);
  mede(); filtra();
})();
