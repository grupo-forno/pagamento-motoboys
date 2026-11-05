// Design system: HTML seguro, ícones, CSS e layout base.

class Raw { constructor(s) { this.s = s; } }
const esc = (v) => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(esc).join('') : v == null || v === false ? ''
  : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (s, ...v) => new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? esc(v[i]) : ''), ''));

// Ícones no estilo Lucide (traço 2px), desenhados inline.
const ICONES = {
  bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  lista: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  pessoas: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  pessoa: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  escudo: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  mais: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  seta: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  voltar: '<path d="m15 18-6-6 6-6"/>',
  baixar: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  subir: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  arquivo: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  alerta: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  erro: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  enviar: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  carteira: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  relogio: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  lapis: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  chave: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  historico: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  lixo: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  desfazer: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  balao: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  calendario: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  clipe: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  busca: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pacote: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>',
  ajustes: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  email: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  loja: '<path d="M3 9 5 4h14l2 5"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z"/><path d="M5 13v7h14v-7"/><path d="M10 20v-4h4v4"/>',
  copiar: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};
const icone = (n, cls = '') => new Raw(`<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONES[n]}</svg>`);
const iniciais = (nome) => String(nome || '?').trim().split(/\s+/).filter((p) => p.length > 2 || /^[A-ZÀ-Ú]/.test(p)).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--surface-2:#f8fafc;--tx:#0f172a;--tx-2:#334155;--mut:#64748b;--bd:#e2e8f0;--bd-2:#cbd5e1;
--pri:#c2410c;--pri-h:#9a3412;--pri-soft:#fff7ed;--pri-bd:#fed7aa;--ok:#15803d;--ok-soft:#f0fdf4;--ok-bd:#bbf7d0;
--warn:#b45309;--warn-soft:#fffbeb;--warn-bd:#fde68a;--bad:#b91c1c;--bad-soft:#fef2f2;--bad-bd:#fecaca;--info:#1d4ed8;--info-soft:#eff6ff;--info-bd:#bfdbfe;
--r:12px;--r-sm:8px;--sh:0 1px 2px rgba(15,23,42,.05),0 1px 3px rgba(15,23,42,.06);--sh-lg:0 12px 32px -12px rgba(15,23,42,.22);--ring:0 0 0 3px rgba(194,65,12,.25)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--tx);-webkit-font-smoothing:antialiased}
a{color:var(--pri)}a:hover{color:var(--pri-h)}h1,h2,h3{margin:0;letter-spacing:-.01em}h1{font-size:24px;font-weight:700}h2{font-size:16px;font-weight:600}h3{font-size:15px;font-weight:600}p{margin:0}
.ico{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}.ico.sm{width:15px;height:15px;vertical-align:-2px}.ico.lg{width:24px;height:24px}
.num,td.n{font-variant-numeric:tabular-nums}
.top{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.94);backdrop-filter:saturate(1.6) blur(8px);border-bottom:1px solid var(--bd)}
.top-in{max-width:1240px;margin:0 auto;padding:0 20px;height:64px;display:flex;align-items:center;gap:24px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--tx)}.brand:hover{color:var(--tx)}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#f97316,#c2410c);color:#fff;display:grid;place-items:center;box-shadow:0 6px 14px -6px rgba(194,65,12,.7);flex:none}
.brand b{display:block;font-size:15px;line-height:1.15}.brand small{display:block;font-size:12px;color:var(--mut)}
.tabs{display:flex;gap:4px;flex:1;overflow-x:auto}
.tabs a{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--r-sm);color:var(--tx-2);text-decoration:none;font-weight:500;white-space:nowrap}
.tabs a:hover{background:var(--surface-2);color:var(--tx)}.tabs a.on{background:var(--pri-soft);color:var(--pri)}
.me{display:flex;align-items:center;gap:4px}.me>a{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--tx);padding:4px 8px;border-radius:var(--r-sm)}.me>a:hover{background:var(--surface-2);color:var(--tx)}
.avatar{width:34px;height:34px;border-radius:50%;background:#ffedd5;color:var(--pri);display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.me-txt b{display:block;font-size:14px;line-height:1.2;font-weight:600}.me-txt small{display:block;font-size:12px;color:var(--mut)}
.icon-btn{background:none;border:0;padding:9px;border-radius:var(--r-sm);color:var(--mut);cursor:pointer;display:grid;place-items:center}.icon-btn:hover{background:var(--surface-2);color:var(--tx)}
.wrap{max-width:1240px;margin:0 auto;padding:24px 20px 72px}
.crumbs{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--mut);margin-bottom:8px;flex-wrap:wrap}.crumbs a{color:var(--mut);text-decoration:none;font-weight:500}.crumbs a:hover{color:var(--pri)}
.ph{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}.ph .sub{color:var(--mut);margin-top:4px}
.ph-actions{display:flex;gap:8px;flex-wrap:wrap}
.stack>*+*{margin-top:20px}
.split{display:grid;gap:20px;grid-template-columns:minmax(0,1fr) 380px;align-items:start}
@media(max-width:980px){.split{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--bd);border-radius:var(--r);box-shadow:var(--sh)}
.card-b{padding:20px}.card-h{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.card-h .t{flex:1;min-width:200px}.card-h .t p{color:var(--mut);font-size:13px;margin-top:2px}
.card-f{padding:14px 20px;border-top:1px solid var(--bd);background:var(--surface-2);border-radius:0 0 var(--r) var(--r);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.card.warn{border-color:var(--warn-bd)}.card.warn>.card-h{background:var(--warn-soft);border-radius:var(--r) var(--r) 0 0;border-color:var(--warn-bd)}
.hico{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--surface-2);color:var(--tx-2);flex:none}
.hico.pri{background:var(--pri-soft);color:var(--pri)}.hico.warn{background:#fef3c7;color:var(--warn)}.hico.ok{background:#dcfce7;color:var(--ok)}.hico.info{background:#dbeafe;color:var(--info)}
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:20px}
.stat{padding:16px 18px;display:flex;gap:14px;align-items:center}
.stat .v{font-size:22px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.2}.stat .l{font-size:13px;color:var(--mut)}
.stat.hero{background:linear-gradient(135deg,#fff7ed,#fff);border-color:var(--pri-bd)}.stat.hero .v{color:var(--pri);font-size:26px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;border-radius:var(--r-sm);border:1px solid transparent;font:inherit;font-weight:600;font-size:14px;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s,box-shadow .15s,color .15s}
.btn:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,summary:focus-visible,.icon-btn:focus-visible{outline:none;box-shadow:var(--ring)}
.btn-pri{background:var(--pri);color:#fff}.btn-pri:hover{background:var(--pri-h);color:#fff}
.btn-sec{background:var(--surface);color:var(--tx);border-color:var(--bd-2)}.btn-sec:hover{background:var(--surface-2);color:var(--tx)}
.btn-soft{background:var(--pri-soft);color:var(--pri);border-color:var(--pri-bd)}.btn-soft:hover{background:#ffedd5;color:var(--pri-h)}
.btn-ghost{background:transparent;color:var(--tx-2)}.btn-ghost:hover{background:var(--surface-2);color:var(--tx)}
.btn-ok{background:var(--ok);color:#fff}.btn-ok:hover{background:#166534;color:#fff}
.btn-bad{background:var(--surface);color:var(--bad);border-color:var(--bad-bd)}.btn-bad:hover{background:var(--bad-soft);color:var(--bad)}
.btn-sm{height:32px;padding:0 12px;font-size:13px}.btn-lg{height:48px;padding:0 22px;font-size:15px}.btn-block{width:100%}
.btn:disabled{opacity:.45;cursor:not-allowed}.btn-pri:disabled:hover{background:var(--pri)}
.link-btn{background:none;border:0;padding:0;font:inherit;color:var(--mut);text-decoration:underline;cursor:pointer;font-size:13px}.link-btn:hover{color:var(--tx)}
form.in{display:inline}
.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:99px;font-size:12px;font-weight:600;background:var(--surface-2);color:var(--tx-2);border:1px solid var(--bd);white-space:nowrap;text-decoration:none;vertical-align:middle}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.badge.nodot::before{display:none}
.badge.rascunho,.badge.warn{background:var(--warn-soft);color:var(--warn);border-color:var(--warn-bd)}
.badge.enviado,.badge.info{background:var(--info-soft);color:var(--info);border-color:var(--info-bd)}
.badge.pago,.badge.ok{background:var(--ok-soft);color:var(--ok);border-color:var(--ok-bd)}
.badge.bad{background:var(--bad-soft);color:var(--bad);border-color:var(--bad-bd)}a.badge:hover{filter:brightness(.96)}
button.badge{cursor:pointer;font:inherit;font-size:12px;font-weight:600}button.badge[aria-expanded=true] .ico:last-child{transform:rotate(90deg)}tr.det>td{background:#fffbeb;white-space:normal;padding:0}.grade tr.det>td:first-child{position:static;box-shadow:inset 4px 0 0 #f59e0b}
.busca-sel{margin-bottom:6px;height:36px!important}a.nome{color:inherit;text-decoration:none}a.nome:hover b{color:var(--pri);text-decoration:underline}
.alert{display:flex;gap:12px;padding:14px 16px;border-radius:var(--r);border:1px solid var(--info-bd);background:var(--info-soft);color:#1e3a8a;margin-bottom:16px;font-size:14px}
.alert>.ico{margin-top:1px}.alert>div>b:first-child{display:block;font-size:15px}
.alert.ok{background:var(--ok-soft);border-color:var(--ok-bd);color:#14532d}.alert.warn{background:var(--warn-soft);border-color:var(--warn-bd);color:#78350f}.alert.bad{background:var(--bad-soft);border-color:var(--bad-bd);color:#7f1d1d}
.alert a{color:inherit;font-weight:600}
.next{display:flex;gap:16px;align-items:center;padding:18px 20px;border-radius:var(--r);background:linear-gradient(135deg,#fff7ed,#fff 70%);border:1px solid var(--pri-bd);margin-bottom:20px;flex-wrap:wrap;box-shadow:var(--sh)}
.next .t{flex:1;min-width:240px}.next .t b{font-size:16px;display:block}.next .t p{color:var(--tx-2);margin-top:2px;font-size:14px}
.next ul{margin:8px 0 0;padding:0;list-style:none}.next li{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--tx-2);margin-top:4px}.next li .ico{color:var(--warn)}
.next.done{background:linear-gradient(135deg,#f0fdf4,#fff 70%);border-color:var(--ok-bd)}.next.wait{background:var(--surface);border-color:var(--bd)}
.stepper{display:flex;list-style:none;padding:0;margin:0 0 20px}
.stepper li{flex:1;display:flex;flex-direction:column;align-items:center;text-align:center;position:relative;font-size:13px;color:var(--mut);font-weight:500;gap:8px;padding:0 4px}
.stepper li::before{content:"";position:absolute;top:15px;left:-50%;right:50%;height:2px;background:var(--bd)}.stepper li:first-child::before{display:none}
.stepper .dot{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--surface);border:2px solid var(--bd-2);color:var(--mut);font-weight:700;font-size:13px;position:relative;z-index:1}
.stepper li.feito{color:var(--tx-2)}.stepper li.feito::before,.stepper li.atual::before{background:var(--ok)}
.stepper li.feito .dot{background:var(--ok);border-color:var(--ok);color:#fff}
.stepper li.atual{color:var(--pri);font-weight:700}.stepper li.atual .dot{border-color:var(--pri);color:var(--pri);background:var(--pri-soft);box-shadow:0 0 0 5px rgba(194,65,12,.12)}
.tw{overflow-x:auto}
table{border-collapse:separate;border-spacing:0;width:100%}
th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--bd);vertical-align:middle}
th{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);background:var(--surface-2);white-space:nowrap}
tr:not(.tot):hover>td{background:#fbfcfd}tr:last-child>td{border-bottom:0}
td.n,th.n{text-align:right;white-space:nowrap}
tr.tot>td{background:var(--surface-2);font-weight:700;border-top:1px solid var(--bd-2)}
tr[data-href]{cursor:pointer}
.grade td{white-space:nowrap}
.grade td:first-child,.grade th:first-child{position:sticky;left:0;z-index:2;background:var(--surface);box-shadow:inset -1px 0 0 var(--bd)}
.grade th:first-child,.grade tr.tot>td:first-child{background:var(--surface-2)}
.cell{display:inline-block;min-width:84px;padding:5px 8px;border-radius:6px;color:var(--tx);text-decoration:none;text-align:right}
a.cell:hover{background:var(--pri-soft);color:var(--pri)}
.cell.div{background:var(--warn-soft);color:var(--warn);font-weight:600}
.cell.vazio{color:var(--bd-2)}
.alert .badge{white-space:normal;height:auto;min-height:24px;padding:3px 10px;line-height:1.35;border-radius:8px}
.pix{display:inline-flex;align-items:center;gap:4px}.pix .icon-btn{padding:4px}
details.alert>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px}details.alert>summary::-webkit-details-marker{display:none}
.who{display:flex;align-items:center;gap:10px}.who .avatar{width:32px;height:32px;font-size:12px}.who b{font-weight:600}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--mut);align-items:center}.legend i{display:inline-block;width:14px;height:14px;border-radius:4px;vertical-align:-2px;margin-right:6px}
.field{margin-bottom:16px}.field>label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.hint{font-size:13px;color:var(--mut);margin-top:6px}.req{color:var(--pri)}
input:not([type=checkbox]):not([type=file]),select,textarea{width:100%;height:42px;padding:0 12px;border:1px solid var(--bd-2);border-radius:var(--r-sm);background:#fff;font:inherit;color:var(--tx);transition:border-color .15s,box-shadow .15s}
textarea{height:auto;min-height:110px;padding:10px 12px;resize:vertical;line-height:1.5}
input:focus,select:focus,textarea:focus{border-color:var(--pri);outline:none;box-shadow:var(--ring)}
input:disabled,select:disabled{background:var(--surface-2);color:var(--mut)}
.money{position:relative}.money>span{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--mut);font-weight:600;font-size:14px}.money>input{padding-left:42px!important;font-variant-numeric:tabular-nums;font-weight:600}
.check{display:flex;align-items:center;gap:10px;font-weight:500;cursor:pointer;margin-bottom:16px}.check input{width:18px;height:18px;accent-color:var(--pri)}
.drop{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:28px 16px;border:2px dashed var(--bd-2);border-radius:var(--r);background:var(--surface-2);text-align:center;color:var(--mut);transition:border-color .15s,background .15s}
.drop:hover,.drop.on{border-color:var(--pri);background:var(--pri-soft)}.drop b{color:var(--tx)}.drop>.ico{color:var(--pri)}
.field>label.drop{display:flex;margin-bottom:0;font-weight:400;font-size:14px}
.drop input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}.drop .fname{font-weight:600;color:var(--pri);font-size:14px}
.fgrid{display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.mut{color:var(--mut)}.small{font-size:13px}.warn-t{color:var(--warn)}.ok-t{color:var(--ok)}.bad-t{color:var(--bad)}.b{font-weight:600}
.empty{text-align:center;padding:48px 20px}.empty .hico{width:56px;height:56px;border-radius:16px;margin:0 auto 14px}.empty>p{color:var(--mut);max-width:460px;margin:6px auto 18px}
.passos{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.passo{display:flex;gap:12px;padding:14px;border:1px solid var(--bd);border-radius:var(--r);background:var(--surface);text-align:left}
.passo .n{width:28px;height:28px;border-radius:50%;background:var(--pri-soft);color:var(--pri);display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.passo p{font-size:14px;color:var(--tx-2)}.passo b{color:var(--tx)}
.daygrid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.day{display:block;padding:14px 16px;border:1px solid var(--bd);border-radius:var(--r);background:#fff;text-decoration:none;color:var(--tx);transition:border-color .15s,box-shadow .15s,transform .15s}
.day:hover{border-color:var(--pri);box-shadow:var(--sh-lg);color:var(--tx);transform:translateY(-1px)}
.day .d{font-size:13px;color:var(--mut);font-weight:600}.day .v{font-size:19px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}.day .e{font-size:12px;color:var(--mut)}
.day.div{background:var(--warn-soft);border-color:var(--warn-bd)}
.items>*{padding:16px 20px;border-bottom:1px solid var(--bd)}.items>*:last-child{border-bottom:0}
.item-h{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
.flow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-variant-numeric:tabular-nums;font-size:14px;margin:8px 0;color:var(--tx-2)}
.quote{white-space:pre-wrap;background:var(--surface-2);border-left:3px solid var(--bd-2);padding:8px 12px;border-radius:0 6px 6px 0;font-size:14px;color:var(--tx-2);margin-top:8px}
.timeline{list-style:none;margin:0;padding:0}.timeline li{position:relative;padding:0 0 14px 22px;font-size:14px;color:var(--tx-2)}
.timeline li::before{content:"";position:absolute;left:3px;top:7px;width:9px;height:9px;border-radius:50%;background:var(--bd-2)}
.timeline li::after{content:"";position:absolute;left:7px;top:19px;bottom:0;width:1px;background:var(--bd)}.timeline li:last-child::after{display:none}
.timeline small{display:block;color:var(--mut);font-size:12px}
details.fold>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;font-weight:600}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary .chev{transition:transform .15s;color:var(--mut)}details.fold[open]>summary .chev{transform:rotate(90deg)}
.progress{height:8px;background:var(--bd);border-radius:99px;overflow:hidden;margin-top:8px;max-width:360px}.progress>i{display:block;height:100%;background:var(--ok);border-radius:99px}
.search{position:relative;min-width:220px}.search>.ico{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--mut)}.search>input{padding-left:38px!important;height:38px!important}
.seg{display:inline-flex;background:var(--surface);border:1px solid var(--bd);border-radius:10px;padding:3px;gap:2px;flex-wrap:wrap}
.seg a{padding:6px 12px;border-radius:7px;color:var(--tx-2);text-decoration:none;font-size:14px;font-weight:500}.seg a.on{background:var(--tx);color:#fff}.seg a:not(.on):hover{background:var(--surface-2);color:var(--tx)}
.seg .c{font-size:12px;opacity:.7;margin-left:4px}
.seg button{border:0;background:none;font:inherit;padding:6px 12px;border-radius:7px;color:var(--tx-2);font-size:14px;font-weight:500;cursor:pointer}.seg button.on{background:var(--tx);color:#fff}.seg button:not(.on):hover{background:var(--surface-2)}
table[data-f=com] tr[data-div="0"],table[data-f=sem] tr[data-div="1"],table[data-f=res] tr[data-res="0"]{display:none}
tr.nobate>td,.grade tr.nobate>td:first-child{background:#fef2f2}.grade tr.nobate>td:first-child{box-shadow:inset 4px 0 0 var(--bad),inset -1px 0 0 var(--bd)}
tr.alt>td,.grade tr.alt>td:first-child{background:#fffbeb}.grade tr.alt>td:first-child{box-shadow:inset 4px 0 0 #f59e0b,inset -1px 0 0 var(--bd)}
.badge.div{background:#fef3c7;color:#92400e;border-color:#fcd34d}
body.auth{min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(1000px 500px at 0% -10%,#ffedd5 0,transparent 60%),radial-gradient(800px 500px at 110% 110%,#fee2e2 0,transparent 55%),var(--bg)}
.auth-box{width:100%;max-width:400px}.auth-box .brand{justify-content:center;margin-bottom:22px}.auth-box .brand b{font-size:18px}.auth-box .brand>span:last-child{display:block!important}

@media(max-width:760px){.top-in{gap:10px;padding:0 12px;height:58px}.brand>span:last-child,.me-txt{display:none}.tabs a .tx{display:none}.tabs a{padding:9px 11px}
.wrap{padding:16px 12px 56px}h1{font-size:21px}.card-b{padding:16px}.card-h{padding:14px 16px}.items>*{padding:14px 16px}.btn{height:44px}.btn-sm{height:36px}.stepper li{font-size:11px}.ph{margin-bottom:16px}}
@media print{.top,.ph-actions,.no-print,form,.btn{display:none!important}.card{box-shadow:none}body{background:#fff}}`;

const JS = `
document.addEventListener('click',function(e){var tr=e.target.closest('tr[data-href]');if(tr&&!e.target.closest('a,button,input,select,form,label'))location.href=tr.dataset.href});
document.querySelectorAll('[data-filtro]').forEach(function(i){i.addEventListener('input',function(){var q=i.value.normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().trim();
document.querySelectorAll(i.dataset.filtro+' [data-q]').forEach(function(r){r.hidden=!!q&&r.dataset.q.indexOf(q)<0})})});
document.querySelectorAll('.drop input[type=file]').forEach(function(i){i.addEventListener('change',function(){var n=[].map.call(i.files,function(f){return f.name}).join(', ');var d=i.closest('.drop');d.classList.toggle('on',!!n);d.querySelector('.fname').textContent=n})});
document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){setTimeout(function(){if(e.defaultPrevented)return;f.querySelectorAll('button[type=submit],button:not([type])').forEach(function(b){b.disabled=true})},0)})});
document.addEventListener('click',function(e){var b=e.target.closest('[data-copiar]');if(!b)return;e.preventDefault();
navigator.clipboard.writeText(b.dataset.copiar).then(function(){var t=b.title;b.title='Copiado!';b.classList.add('ok-t');setTimeout(function(){b.title=t;b.classList.remove('ok-t')},1500)})});
document.querySelectorAll('[data-div-filtro]').forEach(function(seg){seg.addEventListener('click',function(e){var b=e.target.closest('button[data-f]');if(!b)return;
seg.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);x.setAttribute('aria-pressed',x===b)});document.querySelector(seg.dataset.divFiltro).dataset.f=b.dataset.f})});
document.addEventListener('click',function(e){var b=e.target.closest('[data-abre]');if(!b)return;var r=document.querySelector('tr[data-det="'+b.dataset.abre+'"]');if(!r)return;r.hidden=!r.hidden;b.setAttribute('aria-expanded',!r.hidden)});
document.querySelectorAll('[data-todos]').forEach(function(t){t.addEventListener('change',function(){document.querySelectorAll('input[name=m][form='+t.dataset.todos+']').forEach(function(c){c.checked=t.checked})})});
document.querySelectorAll('select[data-busca]').forEach(function(s){var n=function(t){return t.normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase()};
var i=document.createElement('input');i.type='search';i.placeholder='Buscar motoboy por nome…';i.className='busca-sel';i.setAttribute('aria-label','Buscar motoboy por nome');s.parentNode.insertBefore(i,s);
i.addEventListener('input',function(){var q=n(i.value.trim()),vis=[];[].forEach.call(s.options,function(o){var fixa=!o.value||o.value==='novo',ok=fixa||!q||n(o.text).indexOf(q)>=0;o.hidden=!ok;o.disabled=!ok;if(ok&&!fixa)vis.push(o)});
if(q&&vis.length===1)s.value=vis[0].value;else if(s.selectedOptions[0]&&s.selectedOptions[0].disabled)s.value=''})});`;

module.exports = { Raw, html, esc, icone, iniciais, semAcento, CSS, JS };
