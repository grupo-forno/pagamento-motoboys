// Carregamento: barra no topo a cada navegação, botões com "aguarde", tela de espera nas operações longas e aviso de falta de conexão.
const MOTO = '<circle cx="5" cy="18" r="2.6"/><circle cx="19" cy="18" r="2.6"/><rect x="2.5" y="7" width="7.5" height="6" rx="1.3"/><path d="M7.5 18h6l1.8-4.5h3.2"/><path d="M15.3 13.5 14 8.5h-2"/><path d="M18.5 13.5 19 15.4"/><path d="M6 13v2.5"/>';
const barra = document.createElement('div');
barra.className = 'carga-barra'; barra.setAttribute('role', 'progressbar'); barra.setAttribute('aria-label', 'Carregando a página'); barra.innerHTML = '<i></i>';
document.body.appendChild(barra);
let seguranca = 0;
const inicia = () => { barra.classList.add('on'); clearTimeout(seguranca); seguranca = setTimeout(() => barra.classList.remove('on'), 12000); }; // baixar arquivo não troca de página
const para = () => { barra.classList.remove('on'); clearTimeout(seguranca); };

// Links internos: a barra aparece enquanto a próxima tela carrega.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download') || a.dataset.semCarga) return;
  const h = a.getAttribute('href');
  if (!h || h[0] === '#' || /^(javascript|mailto|tel):/.test(h) || a.origin !== location.origin) return;
  if (/\/(xlsx|pdf)$/.test(a.pathname) || (a.pathname === location.pathname && a.search === location.search && a.hash)) return;
  inicia();
});

// Formulários: botão com "aguarde" e, nas operações longas (data-carregando), uma tela de espera com a moto.
function espera(msg, sub) {
  const o = document.createElement('div');
  o.className = 'carregando'; o.setAttribute('role', 'status');
  o.innerHTML = '<div class="carregando-box"><svg class="ico moto-anda" viewBox="0 0 24 24" aria-hidden="true">' + MOTO + '</svg><b></b><span></span><i class="estrada"></i></div>';
  o.querySelector('b').textContent = msg; o.querySelector('span').textContent = sub || 'Só um instante.';
  document.body.appendChild(o);
}
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || e.defaultPrevented || f.dataset.semCarga) return;
  if (f.checkValidity && !f.checkValidity()) return;
  inicia();
  if (f.method.toLowerCase() === 'get') return;
  const b = e.submitter;
  if (b && b.tagName === 'BUTTON') { b.classList.add('is-loading'); b.setAttribute('aria-busy', 'true'); setTimeout(() => { b.dataset.carga = '1'; b.disabled = true; }, 0); }
  const msg = f.dataset.carregando || (f.classList.contains('importar') ? 'Lendo os arquivos…' : '');
  if (msg && !f.closest('dialog[open]')) espera(msg, f.dataset.carregandoSub || 'Confira o resultado em instantes.');
});

// Voltar pelo histórico do navegador: limpa os estados de espera.
addEventListener('pageshow', (e) => {
  para();
  document.querySelectorAll('.carregando').forEach((x) => x.remove());
  document.querySelectorAll('button.is-loading').forEach((b) => { b.classList.remove('is-loading'); b.removeAttribute('aria-busy'); if (b.dataset.carga) { b.disabled = false; delete b.dataset.carga; } });
});

// Sem internet: avisa antes de a pessoa tentar salvar.
const aviso = document.createElement('div');
aviso.className = 'aviso-rede'; aviso.setAttribute('role', 'status'); aviso.hidden = true;
aviso.textContent = 'Sem conexão com a internet. Confira a rede antes de salvar ou enviar.';
document.body.appendChild(aviso);
const rede = () => { aviso.hidden = navigator.onLine; };
addEventListener('offline', rede); addEventListener('online', rede); rede();

// Fila: no celular os filtros começam recolhidos, a menos que haja filtro ativo.
document.querySelectorAll('.filtros-det').forEach((d) => { if (matchMedia('(max-width:760px)').matches && d.dataset.ativos !== '1') d.open = false; });

// Popups (data-abre abre, data-fecha fecha) e clique fora para fechar.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-abre]');
  if (a) { const d = document.getElementById(a.dataset.abre); if (d && !d.open) { d.showModal(); const p = d.querySelector('input:not([type=hidden]),select,a,button'); if (p) p.focus(); } return; }
  const f = e.target.closest && e.target.closest('[data-fecha]'); if (f) { const d = f.closest('dialog'); if (d) d.close(); return; }
  if (e.target instanceof HTMLDialogElement && e.target.classList.contains('dlg-per')) e.target.close();
});
