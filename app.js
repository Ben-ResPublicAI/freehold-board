/* Freehold mijlpalenbord.
   Eén pagina, geen framework. De gegevens leven in Supabase; deze code
   tekent ze en stuurt wijzigingen terug. Wie mag lezen en schrijven wordt
   in de database beslist (Row Level Security), de pagina verbergt alleen wat
   toch niet zou lukken. */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------

  const KOLOMMEN = [
    { id: "open", naam: "Open" },
    { id: "in_uitvoering", naam: "In uitvoering" },
    { id: "wacht_op", naam: "Wacht op" },
    { id: "gehaald", naam: "Gehaald" },
    { id: "vervallen", naam: "Vervallen" },
  ];
  const KOLOM_NAAM = Object.fromEntries(KOLOMMEN.map((k) => [k.id, k.naam]));
  const AFGEROND = new Set(["gehaald", "vervallen"]);
  const MAANDEN = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const ACTIE_TEKST = {
    aangemaakt: "maakte aan",
    verplaatst: "verplaatste",
    bewerkt: "bewerkte",
    checklist: "werkte de checklist bij van",
    opmerking: "reageerde op",
    verwijderd: "verwijderde",
  };

  const $app = document.getElementById("app");
  const cfg = window.FREEHOLD_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).has("demo");

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  const S = {
    sessie: null,          // Supabase session
    ik: null,              // row in mensen for the signed-in user, null when not on the list
    mensen: [],
    kaarten: [],
    opmerkingen: [],       // for the open card
    activiteit: [],        // recent, across the board
    instellingen: {},
    peers: [],             // {key, naam, kaart_id}
    view: "bord",          // bord | mensen | activiteit | instellingen
    lanes: false,
    filters: { oprichter: "alle", periode: "alle", gedeeld: false, zoek: "" },
    open: null,            // id of the card in the drawer
    persoonModal: null,    // person being edited, {} for new
    saveStatus: "",
    gate: { status: "", err: false, sent: false },
    dragId: null,
  };

  let store = null;

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now());
  const byId = (arr, id) => arr.find((x) => x.id === id) || null;
  const persoon = (id) => byId(S.mensen, id);
  const naamVan = (id) => (persoon(id) || {}).naam || "";
  const initialen = (naam) =>
    (naam || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
  const vandaag = () => new Date().toISOString().slice(0, 10);

  function edate(iso, n) {
    // Same month arithmetic as EDATE: same day n months on, clamped to the month's length.
    const [y0, m0, d0] = iso.split("-").map(Number);
    const m = m0 - 1 + n;
    const y = y0 + Math.floor(m / 12);
    const mm = ((m % 12) + 12) % 12;
    const last = new Date(Date.UTC(y, mm + 1, 0)).getUTCDate();
    const d = Math.min(d0, last);
    return `${y}-${String(mm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function aanvangsdatum() {
    return S.instellingen.aanvangsdatum || "2026-09-30";
  }
  function streefdatumVan(k) {
    if (k.maand !== null && k.maand !== undefined && k.maand !== "") return edate(aanvangsdatum(), Number(k.maand));
    return k.streefdatum || null;
  }
  function fmtDatum(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return `${d} ${MAANDEN[m - 1]} ${y}`;
  }
  function fmtTijd(ts) {
    const d = new Date(ts);
    const dd = `${d.getDate()} ${MAANDEN[d.getMonth()]}`;
    const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `${dd}, ${hh}`;
  }
  function isTeLaat(k) {
    const sd = streefdatumVan(k);
    return !!sd && sd < vandaag() && !AFGEROND.has(k.kolom);
  }
  function periodeVan(k) {
    if (k.periode) return k.periode;
    if (k.maand === null || k.maand === undefined) return null;
    const n = Number(k.maand);
    return n <= 6 ? 1 : n <= 12 ? 2 : n <= 18 ? 3 : 4;
  }
  const oprichters = () => S.mensen.filter((m) => m.soort === "oprichter" && m.actief).sort((a, b) => a.volgorde - b.volgorde);
  const magBewerken = () => !!(S.ik && S.ik.mag_bewerken && S.ik.actief);
  const isBeheerder = () => !!(S.ik && S.ik.is_beheerder && S.ik.actief);

  let toastTimer = null;
  function toast(msg, err) {
    let t = document.querySelector(".toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      t.setAttribute("role", "status");
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle("err", !!err);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), err ? 6000 : 2600);
  }

  // Icons: line icons, 1.75 stroke, round caps, per huisstijl section 14.
  const ICON = {
    comment: '<svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 9.5 17 19 7.5"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  };

  const LOCKUP_SVG = `<svg viewBox="0 0 128 100" role="img" aria-label="Het Membraan" focusable="false">
    <g stroke="currentColor" stroke-linecap="round" stroke-width="2.2" fill="none">
      <line x1="10" y1="42" x2="10" y2="58" opacity="0.22"/><line x1="19" y1="34" x2="19" y2="68" opacity="0.3"/>
      <line x1="28" y1="46" x2="28" y2="54" opacity="0.18"/><line x1="37" y1="26" x2="37" y2="76" opacity="0.38"/>
      <line x1="46" y1="43" x2="46" y2="59" opacity="0.22"/><line x1="55" y1="31" x2="55" y2="71" opacity="0.3"/>
      <line x1="64" y1="47" x2="64" y2="53" opacity="0.18"/><line x1="73" y1="28" x2="73" y2="74" opacity="0.34"/>
    </g>
    <path d="M40,50 C56,50 70,50 100,51" style="stroke:var(--accent)" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.42"/>
    <path d="M56,52 C70,52 80,49 112,51" style="stroke:var(--accent)" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.3"/>
    <path d="M86,10 C92,32 92,68 86,90" style="stroke:var(--accent)" stroke-width="3.4" stroke-linecap="round" fill="none"/>
    <g style="stroke:var(--accent)" stroke-linecap="round" stroke-width="5.6">
      <line x1="103" y1="38" x2="103" y2="62"/><line x1="115" y1="27" x2="115" y2="73"/>
    </g></svg>`;

  // ------------------------------------------------------------------
  // Store: Supabase
  // ------------------------------------------------------------------

  function SupabaseStore() {
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    let channel = null;
    let presenceKey = null;

    const fail = (e) => {
      throw new Error(e.message || String(e));
    };

    return {
      sb,
      async sessie() {
        const { data } = await sb.auth.getSession();
        return data.session;
      },
      onAuth(cb) {
        sb.auth.onAuthStateChange((_ev, sess) => cb(sess));
      },
      async loginMagicLink(email) {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) fail(error);
      },
      async loginGoogle() {
        const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
        if (error) fail(error);
      },
      async logout() {
        await sb.auth.signOut();
      },
      async laadAlles() {
        const [m, k, i, a] = await Promise.all([
          sb.from("mensen").select("*").order("volgorde").order("naam"),
          sb.from("kaarten").select("*").order("positie"),
          sb.from("instellingen").select("*"),
          sb.from("activiteit").select("*").order("tijdstip", { ascending: false }).limit(200),
        ]);
        for (const r of [m, k, i, a]) if (r.error) fail(r.error);
        return {
          mensen: m.data,
          kaarten: k.data,
          instellingen: Object.fromEntries(i.data.map((r) => [r.sleutel, r.waarde])),
          activiteit: a.data,
        };
      },
      async laadOpmerkingen(kaartId) {
        const { data, error } = await sb.from("opmerkingen").select("*").eq("kaart_id", kaartId).order("aangemaakt_op");
        if (error) fail(error);
        return data;
      },
      async laadActiviteit() {
        const { data, error } = await sb.from("activiteit").select("*").order("tijdstip", { ascending: false }).limit(300);
        if (error) fail(error);
        return data;
      },
      async upsertKaart(k) {
        const row = { ...k };
        delete row.aangemaakt_op; delete row.aangemaakt_door; delete row.bijgewerkt_op; delete row.bijgewerkt_door;
        const { data, error } = await sb.from("kaarten").upsert(row).select().single();
        if (error) fail(error);
        return data;
      },
      async updateKaart(id, patch) {
        const { data, error } = await sb.from("kaarten").update(patch).eq("id", id).select().single();
        if (error) fail(error);
        return data;
      },
      async verwijderKaart(id) {
        const { error } = await sb.from("kaarten").delete().eq("id", id);
        if (error) fail(error);
      },
      async voegOpmerkingToe(kaartId, tekst) {
        const { data, error } = await sb.from("opmerkingen").insert({ kaart_id: kaartId, tekst, auteur_email: "wordt door de database gestempeld" }).select().single();
        if (error) fail(error);
        return data;
      },
      async verwijderOpmerking(id) {
        const { error } = await sb.from("opmerkingen").delete().eq("id", id);
        if (error) fail(error);
      },
      async upsertPersoon(p) {
        const row = { ...p };
        delete row.aangemaakt_op;
        if (!row.id) delete row.id;
        if (row.email === "") row.email = null;
        const { data, error } = await sb.from("mensen").upsert(row).select().single();
        if (error) fail(error);
        return data;
      },
      async setInstelling(sleutel, waarde) {
        const { error } = await sb.from("instellingen").upsert({ sleutel, waarde });
        if (error) fail(error);
      },
      async importeer(kaarten) {
        const { error } = await sb.from("kaarten").upsert(kaarten, { onConflict: "nr" });
        if (error) fail(error);
      },
      abonneer(onChange, onPeers) {
        if (channel) sb.removeChannel(channel);
        presenceKey = uid();
        channel = sb.channel("bord", { config: { presence: { key: presenceKey } } });
        for (const table of ["kaarten", "opmerkingen", "mensen", "activiteit", "instellingen"]) {
          channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => onChange(table, payload));
        }
        channel.on("presence", { event: "sync" }, () => {
          const state = channel.presenceState();
          const peers = [];
          for (const key of Object.keys(state)) for (const p of state[key]) peers.push({ key, me: key === presenceKey, ...p });
          onPeers(peers);
        });
        channel.subscribe(async (status) => {
          if (status === "SUBSCRIBED") await channel.track({ naam: S.ik ? S.ik.naam : "Iemand", kaart_id: S.open });
        });
      },
      async presence(patch) {
        if (channel) await channel.track({ naam: S.ik ? S.ik.naam : "Iemand", kaart_id: S.open, ...patch });
      },
    };
  }

  // ------------------------------------------------------------------
  // Store: demo, in memory, fictional example cards, nothing persists
  // ------------------------------------------------------------------

  function DemoStore() {
    const mensen = [
      { id: "p1", email: "voorbeeld@example.org", naam: "Voorbeeld Gebruiker", organisatie: "Freehold Works", soort: "oprichter", rol: "Voorbeeld", mag_bewerken: true, is_beheerder: true, actief: true, volgorde: 1 },
      { id: "p2", email: null, naam: "Tweede Oprichter", organisatie: "Freehold Works", soort: "oprichter", rol: "Voorbeeld", mag_bewerken: true, is_beheerder: false, actief: true, volgorde: 2 },
      { id: "p3", email: null, naam: "Externe Adviseur", organisatie: "Voorbeeldkantoor", soort: "extern", rol: "Adviseur", mag_bewerken: false, is_beheerder: false, actief: true, volgorde: 100 },
    ];
    const mk = (nr, eig, maand, titel, kolom, extra) => ({
      id: uid(), nr, titel, toets: "Voorbeeld van een toets achteraf.", afhankelijkheid: null, grond: "Voorbeeld, geen echte grond.",
      eigenaar_id: eig, gedeeld_groep: false, gedeeld_met_id: null, periode: null, maand, streefdatum: null, kolom,
      positie: Math.random() * 100, betrokkenen: [], checklist: [], aangemaakt_op: new Date().toISOString(), bijgewerkt_op: new Date().toISOString(), ...extra,
    });
    const kaarten = [
      mk("VB-01", "p1", 1, "Voorbeeld: vennootschap opgericht en stukken getekend.", "in_uitvoering", { gedeeld_groep: true, checklist: [{ id: "c1", tekst: "Akte", gedaan: true }, { id: "c2", tekst: "Statuten", gedaan: false }] }),
      mk("VB-02", "p1", 2, "Voorbeeld: boekhouder aangesteld en rekening geopend.", "open"),
      mk("VB-03", "p2", -1, "Voorbeeld: een mijlpaal waarvan de streefdatum al voorbij is.", "wacht_op", { betrokkenen: ["p3"] }),
      mk("VB-04", "p2", 4, "Voorbeeld: eerste gesprek met een fonds gevoerd.", "open", { gedeeld_met_id: "p1" }),
      mk("VB-05", "p1", 3, "Voorbeeld: een gehaalde mijlpaal.", "gehaald"),
      mk("VB-06", "p2", 8, "Voorbeeld: een mijlpaal in periode twee.", "open"),
    ];
    let opm = [];
    let act = [];
    let cb = () => {};
    const log = (actie, k) => { act.unshift({ id: act.length + 1, tijdstip: new Date().toISOString(), actor_email: mensen[0].email, actor_naam: mensen[0].naam, actie, kaart_id: k.id, kaart_nr: k.nr, detail: { titel: k.titel } }); };
    return {
      async sessie() { return { user: { email: mensen[0].email } }; },
      onAuth() {},
      async loginMagicLink() {}, async loginGoogle() {}, async logout() { location.search = ""; },
      async laadAlles() { return { mensen, kaarten, instellingen: { aanvangsdatum: "2026-09-30" }, activiteit: act }; },
      async laadOpmerkingen(id) { return opm.filter((o) => o.kaart_id === id); },
      async laadActiviteit() { return act; },
      async upsertKaart(k) { const i = kaarten.findIndex((x) => x.id === k.id); const row = { ...k, bijgewerkt_op: new Date().toISOString() }; if (i >= 0) { kaarten[i] = row; log("bewerkt", row); } else { row.id = row.id || uid(); kaarten.push(row); log("aangemaakt", row); } cb("kaarten"); return row; },
      async updateKaart(id, patch) { const k = byId(kaarten, id); Object.assign(k, patch, { bijgewerkt_op: new Date().toISOString() }); log(patch.kolom ? "verplaatst" : "bewerkt", k); cb("kaarten"); return k; },
      async verwijderKaart(id) { const i = kaarten.findIndex((x) => x.id === id); if (i >= 0) { log("verwijderd", kaarten[i]); kaarten.splice(i, 1); } cb("kaarten"); },
      async voegOpmerkingToe(kaartId, tekst) { const o = { id: uid(), kaart_id: kaartId, auteur_email: mensen[0].email, auteur_naam: mensen[0].naam, tekst, aangemaakt_op: new Date().toISOString() }; opm.push(o); log("opmerking", byId(kaarten, kaartId)); return o; },
      async verwijderOpmerking(id) { opm = opm.filter((o) => o.id !== id); },
      async upsertPersoon(p) { const i = mensen.findIndex((x) => x.id === p.id); const row = { ...p, id: p.id || uid() }; if (i >= 0) mensen[i] = row; else mensen.push(row); cb("mensen"); return row; },
      async setInstelling() {},
      async importeer() {},
      abonneer(onChange, onPeers) { cb = (t) => onChange(t, {}); onPeers([{ key: "me", me: true, naam: mensen[0].naam, kaart_id: null }, { key: "x", me: false, naam: "Tweede Oprichter", kaart_id: null }]); },
      async presence() {},
    };
  }

  // ------------------------------------------------------------------
  // Data loading and realtime
  // ------------------------------------------------------------------

  async function laadAlles() {
    const d = await store.laadAlles();
    S.mensen = d.mensen;
    S.kaarten = d.kaarten;
    S.instellingen = d.instellingen;
    S.activiteit = d.activiteit;
    const email = ((S.sessie && S.sessie.user && S.sessie.user.email) || "").toLowerCase();
    S.ik = S.mensen.find((m) => (m.email || "").toLowerCase() === email && m.actief) || null;
  }

  let herlaadTimer = null;
  function onChange(table, payload) {
    // Keep it simple and correct: apply what we can in place, reload the rest.
    if (table === "kaarten" && payload && payload.eventType) {
      const row = payload.new && payload.new.id ? payload.new : null;
      if (payload.eventType === "DELETE") S.kaarten = S.kaarten.filter((k) => k.id !== (payload.old || {}).id);
      else if (row) {
        const i = S.kaarten.findIndex((k) => k.id === row.id);
        if (i >= 0) S.kaarten[i] = row; else S.kaarten.push(row);
      }
      render();
      return;
    }
    if (table === "opmerkingen" && payload && payload.eventType === "INSERT" && payload.new && payload.new.kaart_id === S.open) {
      if (!S.opmerkingen.some((o) => o.id === payload.new.id)) S.opmerkingen.push(payload.new);
      render();
      return;
    }
    if (table === "activiteit" && payload && payload.eventType === "INSERT" && payload.new) {
      S.activiteit.unshift(payload.new);
      S.activiteit = S.activiteit.slice(0, 300);
      render();
      return;
    }
    clearTimeout(herlaadTimer);
    herlaadTimer = setTimeout(async () => {
      try { await laadAlles(); render(); } catch (e) { toast("Herladen mislukt: " + e.message, true); }
    }, 300);
  }

  function onPeers(peers) {
    S.peers = peers;
    render();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function render() {
    if (DEMO) {
      $app.innerHTML = `<div class="demo-banner">Voorbeeldweergave met verzonnen kaarten. Niets wordt bewaard. Verwijder <code>?demo</code> uit het adres voor het echte bord.</div>` + renderApp();
    } else if (!S.sessie) {
      $app.innerHTML = renderGate();
    } else if (!S.ik) {
      $app.innerHTML = renderNoAccess();
    } else {
      $app.innerHTML = renderApp();
    }
    bind();
  }

  function renderLockup(big) {
    return `<a class="lockup" href="./" aria-label="Freehold">${LOCKUP_SVG}<span class="wordmark"><span>Free</span><b>hold</b></span></a>`;
  }

  function renderGate() {
    const g = S.gate;
    return `<div class="gate"><div class="gate-card">
      ${renderLockup(true)}
      <div><h1>Mijlpalenbord</h1><p>Voor de oprichters van Freehold Works. Je krijgt een inloglink per e-mail; er is geen wachtwoord.</p></div>
      <form id="gate-form">
        <label class="sr-only" for="gate-email">E-mailadres</label>
        <input id="gate-email" type="email" required autocomplete="email" placeholder="naam@respublicai.org" ${g.sent ? "disabled" : ""}>
        <button class="btn primary" type="submit" ${g.sent ? "disabled" : ""}>Stuur me een inloglink</button>
        <div class="status ${g.err ? "err" : ""}" role="status">${esc(g.status)}</div>
      </form>
      ${cfg.googleLogin ? `<div class="divider">of</div><button class="btn" id="gate-google" type="button">Inloggen met Google</button>` : ""}
      <p class="baseline">Inzichten, nooit data</p>
    </div></div>`;
  }

  function renderNoAccess() {
    const email = (S.sessie.user && S.sessie.user.email) || "";
    return `<div class="gate"><div class="gate-card">
      ${renderLockup(true)}
      <div><h1>Geen toegang</h1><p>Je bent ingelogd als <b>${esc(email)}</b>, maar dat adres staat niet op de lijst van dit bord. Vraag een beheerder om je toe te voegen, en log daarna opnieuw in.</p></div>
      <button class="btn" id="btn-logout" type="button">Uitloggen</button>
    </div></div>`;
  }

  function renderApp() {
    const ik = S.ik || { naam: "" };
    const views = [["bord", "Bord"], ["mensen", "Mensen"], ["activiteit", "Activiteit"], ["instellingen", "Instellingen"]];
    return `
      <header class="topbar">
        ${renderLockup()}
        <span class="app-title">Mijlpalen</span>
        <nav class="nav" aria-label="Onderdelen">
          ${views.map(([id, n]) => `<button type="button" data-view="${id}" ${S.view === id ? 'aria-current="page"' : ""}>${n}</button>`).join("")}
        </nav>
        <div class="who">
          <div class="peers" title="${esc(S.peers.map((p) => p.naam).join(", "))}">${S.peers.map((p) => `<span class="avatar ${p.me ? "me" : ""}" title="${esc(p.naam)}${p.kaart_id ? " bekijkt " + esc((byId(S.kaarten, p.kaart_id) || {}).nr || "een kaart") : ""}">${esc(initialen(p.naam))}</span>`).join("")}</div>
          <span class="name">${esc(ik.naam)}</span>
          <button class="linkbtn" id="btn-logout" type="button">Uitloggen</button>
        </div>
      </header>
      ${S.view === "bord" ? renderFilters() : ""}
      <div class="main">
        ${S.view === "bord" ? renderBoard() : S.view === "mensen" ? renderMensen() : S.view === "activiteit" ? renderActiviteit() : renderInstellingen()}
        ${S.open ? renderDrawer() : ""}
      </div>
      ${S.persoonModal ? renderPersoonModal() : ""}`;
  }

  function renderFilters() {
    const f = S.filters;
    const ops = oprichters();
    return `<div class="filters">
      <div class="chipgroup" role="group" aria-label="Oprichter"><span class="lbl">Oprichter</span>
        <button type="button" class="chip" data-f="oprichter" data-v="alle" aria-pressed="${f.oprichter === "alle"}">Alle</button>
        ${ops.map((o) => `<button type="button" class="chip" data-f="oprichter" data-v="${o.id}" aria-pressed="${f.oprichter === o.id}">${esc(o.naam.split(" ")[0])}</button>`).join("")}
      </div>
      <div class="chipgroup" role="group" aria-label="Periode"><span class="lbl">Periode</span>
        <button type="button" class="chip" data-f="periode" data-v="alle" aria-pressed="${f.periode === "alle"}">Alle</button>
        ${[1, 2, 3, 4].map((p) => `<button type="button" class="chip" data-f="periode" data-v="${p}" aria-pressed="${String(f.periode) === String(p)}">${p}</button>`).join("")}
      </div>
      <div class="chipgroup"><button type="button" class="chip ochre" data-f="gedeeld" data-v="toggle" aria-pressed="${f.gedeeld}">Gedeeld en groep</button></div>
      <label class="sr-only" for="zoek">Zoeken</label>
      <input id="zoek" class="search" type="search" placeholder="Zoek in nummer of tekst" value="${esc(f.zoek)}">
      <span class="spacer"></span>
      <button type="button" class="btn quiet" id="btn-lanes" aria-pressed="${S.lanes}">${S.lanes ? "Kolommen" : "Per oprichter"}</button>
      ${magBewerken() ? `<button type="button" class="btn primary" id="btn-nieuw">Nieuwe mijlpaal</button>` : ""}
    </div>`;
  }

  function gefilterd() {
    const f = S.filters;
    const q = f.zoek.trim().toLowerCase();
    return S.kaarten.filter((k) => {
      if (f.oprichter !== "alle" && k.eigenaar_id !== f.oprichter && k.gedeeld_met_id !== f.oprichter && !(k.betrokkenen || []).includes(f.oprichter)) return false;
      if (f.periode !== "alle" && String(periodeVan(k)) !== String(f.periode)) return false;
      if (f.gedeeld && !k.gedeeld_groep && !k.gedeeld_met_id) return false;
      if (q && !(`${k.nr || ""} ${k.titel} ${k.toets || ""} ${k.afhankelijkheid || ""} ${k.grond || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderBoard() {
    const kaarten = gefilterd();
    if (!S.lanes) {
      return `<div class="view"><div class="board" id="board">${KOLOMMEN.map((c) => renderKolom(c, kaarten.filter((k) => k.kolom === c.id), null)).join("")}</div></div>`;
    }
    const ops = oprichters();
    const lanes = ops.map((o) => {
      const mine = kaarten.filter((k) => k.eigenaar_id === o.id);
      return `<section class="lane" aria-label="${esc(o.naam)}">
        <div class="lane-head"><span class="avatar">${esc(initialen(o.naam))}</span><h2>${esc(o.naam)}</h2><span class="meta">${mine.length} mijlpalen, ${mine.filter((k) => k.kolom === "gehaald").length} gehaald</span></div>
        ${KOLOMMEN.map((c) => renderKolom(c, mine.filter((k) => k.kolom === c.id), o.id)).join("")}
      </section>`;
    });
    const rest = kaarten.filter((k) => !ops.some((o) => o.id === k.eigenaar_id));
    if (rest.length) lanes.push(`<section class="lane" aria-label="Zonder eigenaar"><div class="lane-head"><h2>Zonder eigenaar</h2><span class="meta">${rest.length}</span></div>${KOLOMMEN.map((c) => renderKolom(c, rest.filter((k) => k.kolom === c.id), "")).join("")}</section>`);
    return `<div class="view"><div class="board lanes" id="board">${lanes.join("")}</div></div>`;
  }

  function renderKolom(c, kaarten, laneOwner) {
    kaarten = kaarten.slice().sort((a, b) => a.positie - b.positie);
    return `<div class="col" data-kolom="${c.id}" ${laneOwner !== null ? `data-lane="${laneOwner}"` : ""}>
      <div class="col-head"><span class="dot"></span>${c.naam}<span class="count">${kaarten.length}</span></div>
      <div class="col-list" data-kolom="${c.id}">
        ${kaarten.length ? kaarten.map(renderKaart).join("") : `<div class="empty">Geen mijlpalen</div>`}
      </div></div>`;
  }

  function renderKaart(k) {
    const eig = persoon(k.eigenaar_id);
    const late = isTeLaat(k);
    const sd = streefdatumVan(k);
    const cl = k.checklist || [];
    const done = cl.filter((c) => c.gedaan).length;
    const betr = (k.betrokkenen || []).map(persoon).filter(Boolean);
    const per = periodeVan(k);
    return `<article class="card ${late ? "late" : ""} ${AFGEROND.has(k.kolom) ? "done" : ""}" draggable="${magBewerken()}" data-id="${k.id}" tabindex="0" role="button" aria-label="${esc(k.nr || "")} ${esc(k.titel)}">
      <div class="card-top">
        ${eig ? `<span class="avatar sm" title="${esc(eig.naam)}">${esc(initialen(eig.naam))}</span>` : ""}
        <span class="nr">${esc(k.nr || "")}</span>
        ${k.gedeeld_groep ? `<span class="tag group">Groep</span>` : ""}
        ${k.gedeeld_met_id ? `<span class="tag shared">met ${esc(naamVan(k.gedeeld_met_id).split(" ")[0])}</span>` : ""}
        ${per ? `<span class="period">P${per}</span>` : ""}
      </div>
      <div class="title">${esc(k.titel)}</div>
      <div class="card-bottom">
        ${sd ? `<span class="date" title="Streefdatum">${fmtDatum(sd)}</span>` : `<span class="date">Geen datum</span>`}
        <span class="right">
          ${betr.length ? `<span class="stack">${betr.slice(0, 3).map((p) => `<span class="avatar sm ${p.soort}" title="${esc(p.naam)}">${esc(initialen(p.naam))}</span>`).join("")}</span>` : ""}
          ${cl.length ? `<span class="ico" title="Checklist">${ICON.check}${done}/${cl.length}</span>` : ""}
        </span>
      </div>
    </article>`;
  }

  function renderDrawer() {
    const k = byId(S.kaarten, S.open);
    if (!k) return "";
    const edit = magBewerken();
    const ro = edit ? "" : "disabled";
    const ops = oprichters();
    const mensen = S.mensen.filter((m) => m.actief).sort((a, b) => a.volgorde - b.volgorde || a.naam.localeCompare(b.naam));
    const cl = k.checklist || [];
    const act = S.activiteit.filter((a) => a.kaart_id === k.id).slice(0, 30);
    const sd = streefdatumVan(k);
    return `<div class="drawer-backdrop" id="drawer-backdrop"></div>
    <aside class="drawer" role="dialog" aria-label="Mijlpaal ${esc(k.nr || "")}" data-id="${k.id}">
      <div class="drawer-head">
        <span class="nr">${esc(k.nr || "Nieuw")}</span>
        <span class="tag ${AFGEROND.has(k.kolom) ? "group" : ""}">${esc(KOLOM_NAAM[k.kolom])}</span>
        ${isTeLaat(k) ? `<span class="tag" style="background:var(--signal-tint);color:var(--signal)">Streefdatum voorbij</span>` : ""}
        <button class="btn quiet close" id="drawer-close" type="button" aria-label="Sluiten">${ICON.close}</button>
      </div>
      <div class="drawer-body">
        <div class="field"><label for="f-titel">Mijlpaal</label><textarea id="f-titel" class="title" data-k="titel" ${ro}>${esc(k.titel)}</textarea></div>
        <div class="row3">
          <div class="field"><label for="f-nr">Nummer</label><input id="f-nr" type="text" data-k="nr" value="${esc(k.nr || "")}" ${ro}></div>
          <div class="field"><label for="f-eigenaar">Eigenaar</label><select id="f-eigenaar" data-k="eigenaar_id" ${ro}><option value="">Niemand</option>${ops.map((o) => `<option value="${o.id}" ${k.eigenaar_id === o.id ? "selected" : ""}>${esc(o.naam)}</option>`).join("")}</select></div>
          <div class="field"><label for="f-kolom">Kolom</label><select id="f-kolom" data-k="kolom" ${ro}>${KOLOMMEN.map((c) => `<option value="${c.id}" ${k.kolom === c.id ? "selected" : ""}>${c.naam}</option>`).join("")}</select></div>
        </div>
        <div class="row3">
          <div class="field"><label for="f-maand">Maanden na aanvang</label><input id="f-maand" type="number" min="-12" max="60" data-k="maand" value="${k.maand ?? ""}" ${ro}><span class="hint">Aanvang ${fmtDatum(aanvangsdatum())}</span></div>
          <div class="field"><label for="f-datum">Of vaste streefdatum</label><input id="f-datum" type="date" data-k="streefdatum" value="${k.maand !== null && k.maand !== undefined ? "" : (k.streefdatum || "")}" ${ro}><span class="hint">${sd ? "Nu: " + fmtDatum(sd) : "Geen datum"}</span></div>
          <div class="field"><label for="f-gedeeld">Gedeeld</label><select id="f-gedeeld" data-k="gedeeld" ${ro}><option value="">Nee</option><option value="groep" ${k.gedeeld_groep ? "selected" : ""}>Groep</option>${ops.filter((o) => o.id !== k.eigenaar_id).map((o) => `<option value="${o.id}" ${k.gedeeld_met_id === o.id ? "selected" : ""}>met ${esc(o.naam.split(" ")[0])}</option>`).join("")}</select></div>
        </div>
        <div class="field"><label for="f-toets">Toets achteraf</label><textarea id="f-toets" data-k="toets" ${ro}>${esc(k.toets || "")}</textarea><span class="hint">Het stuk of het feit dat achteraf toont dat de mijlpaal is gehaald.</span></div>
        <div class="field"><label for="f-afh">Afhankelijkheid</label><textarea id="f-afh" data-k="afhankelijkheid" ${ro}>${esc(k.afhankelijkheid || "")}</textarea></div>
        <div class="field"><label for="f-grond">Grond in de stukken</label><textarea id="f-grond" data-k="grond" ${ro}>${esc(k.grond || "")}</textarea></div>

        <div class="field"><span class="label">Betrokkenen</span>
          <div class="people-pick" id="betrokkenen">
            ${mensen.map((m) => `<button type="button" class="pick" data-pid="${m.id}" aria-pressed="${(k.betrokkenen || []).includes(m.id)}" ${ro}><span class="avatar sm ${m.soort}">${esc(initialen(m.naam))}</span>${esc(m.naam)}</button>`).join("")}
            ${mensen.length === 0 ? `<span class="hint">Nog niemand op het blad Mensen.</span>` : ""}
          </div>
        </div>

        <div class="field">
          <span class="section-title">Checklist <span class="n">${cl.filter((c) => c.gedaan).length} van ${cl.length}</span></span>
          <ul class="checklist" id="checklist">
            ${cl.map((c) => `<li class="${c.gedaan ? "done" : ""}" data-cid="${c.id}"><input type="checkbox" ${c.gedaan ? "checked" : ""} ${ro} aria-label="${esc(c.tekst)}"><span class="txt">${esc(c.tekst)}</span>${edit ? `<button type="button" class="rm" aria-label="Verwijder">${ICON.close}</button>` : ""}</li>`).join("")}
          </ul>
          ${edit ? `<form class="addline" id="checklist-add"><input type="text" placeholder="Nieuwe deelstap" aria-label="Nieuwe deelstap"><button class="btn" type="submit">Toevoegen</button></form>` : ""}
        </div>

        <div class="field">
          <span class="section-title">Opmerkingen <span class="n">${S.opmerkingen.length}</span></span>
          <div class="comments">
            ${S.opmerkingen.map((o) => `<div class="comment"><span class="avatar sm">${esc(initialen(o.auteur_naam || o.auteur_email))}</span><div><div class="meta"><b>${esc(o.auteur_naam || o.auteur_email)}</b><time datetime="${esc(o.aangemaakt_op)}">${fmtTijd(o.aangemaakt_op)}</time>${(isBeheerder() || (S.ik && (S.ik.email || "").toLowerCase() === (o.auteur_email || "").toLowerCase())) ? `<button type="button" class="rm linkbtn" data-oid="${o.id}" style="background:none;border:0;color:var(--ink-3);padding:0">verwijder</button>` : ""}</div><div class="body">${esc(o.tekst)}</div></div></div>`).join("")}
            ${S.opmerkingen.length === 0 ? `<span class="hint">Nog geen opmerkingen.</span>` : ""}
          </div>
          ${edit ? `<form class="comment-form" id="comment-form"><label class="sr-only" for="comment-text">Opmerking</label><textarea id="comment-text" placeholder="Schrijf een opmerking voor de anderen"></textarea><div class="actions"><button class="btn primary" type="submit">Plaats</button></div></form>` : ""}
        </div>

        <div class="field">
          <span class="section-title">Geschiedenis</span>
          <ul class="activity">${act.map(renderActiviteitRegel).join("") || `<li><span></span><span class="hint">Nog niets.</span></li>`}</ul>
        </div>
      </div>
      <div class="drawer-foot">
        ${edit ? `<button class="btn danger" id="btn-verwijder" type="button">Verwijderen</button>` : ""}
        <span class="spacer"></span>
        <span class="saved ${S.saveStatus === "Bewaard" ? "ok" : S.saveStatus.startsWith("Niet") ? "err" : ""}">${esc(S.saveStatus)}</span>
        ${edit ? `<button class="btn primary" id="btn-bewaar" type="button">Bewaren</button>` : ""}
      </div>
    </aside>`;
  }

  function renderActiviteitRegel(a) {
    const wie = a.actor_naam || a.actor_email || "Iemand";
    const wat = ACTIE_TEKST[a.actie] || a.actie;
    let extra = "";
    if (a.actie === "verplaatst" && a.detail) extra = ` naar ${esc(KOLOM_NAAM[a.detail.naar] || a.detail.naar)}`;
    return `<li><time datetime="${esc(a.tijdstip)}">${fmtTijd(a.tijdstip)}</time><span><b>${esc(wie)}</b> ${wat} <a href="#" data-open="${a.kaart_id || ""}">${esc(a.kaart_nr || "")}</a>${extra}${a.detail && a.detail.titel && !S.open ? `<span class="sub" style="color:var(--ink-3)">, ${esc(a.detail.titel)}</span>` : ""}</span></li>`;
  }

  function renderMensen() {
    const rows = S.mensen.slice().sort((a, b) => (a.soort === b.soort ? a.volgorde - b.volgorde || a.naam.localeCompare(b.naam) : ["oprichter", "intern", "extern"].indexOf(a.soort) - ["oprichter", "intern", "extern"].indexOf(b.soort)));
    return `<div class="view"><div class="page">
      <div class="page-head"><div><h1>Mensen</h1><p class="lede">Iedereen die bij de mijlpalen betrokken is. Wie een e-mailadres heeft en actief is, kan het bord openen. Wie mag bewerken, kan kaarten verplaatsen en opmerkingen plaatsen.</p></div>${isBeheerder() ? `<button class="btn primary" id="btn-persoon-nieuw" type="button">Persoon toevoegen</button>` : ""}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Naam</th><th>Soort</th><th>Organisatie en rol</th><th>Toegang</th><th>Mijlpalen</th>${isBeheerder() ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows.map((m) => {
          const n = S.kaarten.filter((k) => k.eigenaar_id === m.id || k.gedeeld_met_id === m.id || (k.betrokkenen || []).includes(m.id)).length;
          return `<tr class="${m.actief ? "" : "inactive"}">
            <td><span style="display:flex;gap:8px;align-items:center"><span class="avatar sm ${m.soort}">${esc(initialen(m.naam))}</span><span>${esc(m.naam)}<span class="sub">${esc(m.email || "geen e-mailadres")}</span></span></span></td>
            <td><span class="pill ${m.soort}">${m.soort}</span></td>
            <td>${esc(m.organisatie || "")}<span class="sub">${esc(m.rol || "")}</span></td>
            <td>${!m.actief ? `<span class="pill off">inactief</span>` : m.is_beheerder ? `<span class="pill oprichter">beheerder</span>` : m.mag_bewerken ? `<span class="pill">bewerken</span>` : m.email ? `<span class="pill off">lezen</span>` : `<span class="pill off">geen</span>`}</td>
            <td>${n}</td>
            ${isBeheerder() ? `<td><button type="button" class="btn quiet" data-edit-persoon="${m.id}">Bewerken</button></td>` : ""}
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </div></div>`;
  }

  function renderPersoonModal() {
    const p = S.persoonModal;
    const nieuw = !p.id;
    return `<div class="modal-backdrop" id="modal-backdrop"><form class="modal" id="persoon-form" role="dialog" aria-label="${nieuw ? "Persoon toevoegen" : "Persoon bewerken"}">
      <h2>${nieuw ? "Persoon toevoegen" : esc(p.naam)}</h2>
      <div class="row">
        <div class="field"><label for="p-naam">Naam</label><input id="p-naam" type="text" name="naam" required value="${esc(p.naam || "")}"></div>
        <div class="field"><label for="p-email">E-mailadres</label><input id="p-email" type="text" name="email" value="${esc(p.email || "")}"><span class="hint">Nodig om in te loggen. Leeg voor iemand zonder toegang.</span></div>
      </div>
      <div class="row">
        <div class="field"><label for="p-org">Organisatie</label><input id="p-org" type="text" name="organisatie" value="${esc(p.organisatie || "")}"></div>
        <div class="field"><label for="p-soort">Soort</label><select id="p-soort" name="soort">${["oprichter", "intern", "extern"].map((s) => `<option value="${s}" ${(p.soort || "extern") === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label for="p-rol">Rol in het dossier</label><input id="p-rol" type="text" name="rol" value="${esc(p.rol || "")}"></div>
      <div class="field"><label for="p-not">Notities</label><textarea id="p-not" name="notities">${esc(p.notities || "")}</textarea></div>
      <div class="field"><span class="label">Toegang</span><div class="checks">
        <label><input type="checkbox" name="mag_bewerken" ${p.mag_bewerken ? "checked" : ""}> Mag bewerken<span class="hint">Kaarten verplaatsen en bewerken, opmerkingen plaatsen.</span></label>
        <label><input type="checkbox" name="is_beheerder" ${p.is_beheerder ? "checked" : ""}> Beheerder<span class="hint">Beheert dit blad en de instellingen.</span></label>
        <label><input type="checkbox" name="actief" ${p.actief === false ? "" : "checked"}> Actief<span class="hint">Uitgevinkt: geen toegang meer, de geschiedenis blijft.</span></label>
      </div></div>
      <div class="row"><div class="field"><label for="p-volg">Volgorde</label><input id="p-volg" type="number" name="volgorde" value="${p.volgorde ?? 100}"></div></div>
      <div class="actions"><button type="button" class="btn" id="persoon-annuleer">Annuleren</button><button type="submit" class="btn primary">Bewaren</button></div>
    </form></div>`;
  }

  function renderActiviteit() {
    return `<div class="view"><div class="page">
      <h1>Activiteit</h1><p class="lede">Wat er op het bord gebeurt, gestempeld met wie het deed. De laatste driehonderd regels.</p>
      <ul class="activity" style="font-size:14px;gap:10px">${S.activiteit.map(renderActiviteitRegel).join("") || `<li><span></span><span class="hint">Nog niets.</span></li>`}</ul>
    </div></div>`;
  }

  function renderInstellingen() {
    const adm = isBeheerder();
    const tel = KOLOMMEN.map((c) => `${c.naam} ${S.kaarten.filter((k) => k.kolom === c.id).length}`).join(", ");
    return `<div class="view"><div class="page"><div class="settings">
      <div><h1>Instellingen</h1><p class="lede">${S.kaarten.length} mijlpalen op het bord: ${tel}.</p></div>
      <div class="block"><h2>Aanvangsdatum</h2><p>Elke mijlpaal met een aantal maanden na aanvang rekent haar streefdatum uit deze datum. Verschuift de aanvangsdatum, dan schuiven al die datums mee.</p>
        <div class="field"><label for="s-aanvang">Aanvangsdatum</label><input id="s-aanvang" type="date" value="${esc(aanvangsdatum())}" ${adm ? "" : "disabled"}></div>
        ${adm ? `<div class="actions"><button class="btn primary" id="btn-aanvang" type="button">Bewaren</button></div>` : `<p class="hint">Alleen een beheerder kan dit wijzigen.</p>`}
      </div>
      <div class="block"><h2>Uitvoer</h2><p>Een JSON-bestand met alle mijlpalen, mensen en de aanvangsdatum, om te bewaren of elders in te lezen.</p>
        <div class="actions"><button class="btn" id="btn-export" type="button">Exporteren als JSON</button></div>
      </div>
      ${adm ? `<div class="block"><h2>Invoer</h2><p>Leest mijlpalen in uit een JSON-bestand van dit bord. Kaarten met een bestaand nummer worden bijgewerkt, nieuwe nummers toegevoegd. Mensen worden niet ingelezen.</p>
        <div class="actions"><input type="file" id="import-file" accept="application/json" class="sr-only"><button class="btn" id="btn-import" type="button">JSON-bestand kiezen</button></div>
      </div>` : ""}
      <div class="block"><h2>Weergave</h2><p>Het bord volgt de lichte of donkere instelling van je toestel.</p>
        <div class="actions"><button class="btn" data-theme="light" type="button">Licht</button><button class="btn" data-theme="dark" type="button">Donker</button><button class="btn" data-theme="" type="button">Toestel</button></div>
      </div>
    </div></div></div>`;
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async function openKaart(id) {
    S.open = id;
    S.saveStatus = "";
    S.opmerkingen = [];
    render();
    try {
      S.opmerkingen = await store.laadOpmerkingen(id);
    } catch (e) {
      toast("Opmerkingen laden mislukt: " + e.message, true);
    }
    render();
    store.presence({ kaart_id: id });
  }

  function sluitKaart() {
    S.open = null;
    S.opmerkingen = [];
    render();
    store.presence({ kaart_id: null });
  }

  function leesDrawer() {
    const d = document.querySelector(".drawer");
    const k = { ...byId(S.kaarten, S.open) };
    d.querySelectorAll("[data-k]").forEach((el) => {
      const key = el.dataset.k;
      if (key === "gedeeld") {
        k.gedeeld_groep = el.value === "groep";
        k.gedeeld_met_id = el.value && el.value !== "groep" ? el.value : null;
        return;
      }
      let v = el.value;
      if (key === "maand") v = v === "" ? null : Number(v);
      if (key === "streefdatum") v = v || null;
      if (key === "eigenaar_id") v = v || null;
      if (key === "nr") v = v.trim() || null;
      if (key === "titel") v = v.trim();
      if (["toets", "afhankelijkheid", "grond"].includes(key)) v = v.trim() || null;
      k[key] = v;
    });
    if (k.maand !== null && k.maand !== undefined) k.streefdatum = edate(aanvangsdatum(), Number(k.maand));
    k.periode = k.maand === null || k.maand === undefined ? null : periodeVan({ maand: k.maand });
    return k;
  }

  async function bewaarKaart() {
    const k = leesDrawer();
    if (!k.titel) { S.saveStatus = "Niet bewaard: de mijlpaal heeft geen tekst."; render(); return; }
    S.saveStatus = "Bewaren";
    render();
    try {
      const saved = await store.upsertKaart(k);
      const i = S.kaarten.findIndex((x) => x.id === saved.id);
      if (i >= 0) S.kaarten[i] = saved; else S.kaarten.push(saved);
      S.saveStatus = "Bewaard";
    } catch (e) {
      S.saveStatus = "Niet bewaard: " + e.message;
    }
    render();
  }

  async function patchKaart(id, patch, melding) {
    const k = byId(S.kaarten, id);
    const vorige = { ...k };
    Object.assign(k, patch);
    render();
    try {
      const saved = await store.updateKaart(id, patch);
      Object.assign(k, saved);
    } catch (e) {
      Object.assign(k, vorige);
      toast((melding || "Wijzigen") + " mislukt: " + e.message, true);
    }
    render();
  }

  async function nieuweKaart() {
    const f = S.filters;
    const k = {
      id: uid(), nr: null, titel: "", toets: null, afhankelijkheid: null, grond: null,
      eigenaar_id: f.oprichter !== "alle" ? f.oprichter : (S.ik && S.ik.soort === "oprichter" ? S.ik.id : null),
      gedeeld_groep: false, gedeeld_met_id: null, periode: null, maand: null, streefdatum: null,
      kolom: "open", positie: Math.min(0, ...S.kaarten.filter((x) => x.kolom === "open").map((x) => x.positie)) - 10,
      betrokkenen: [], checklist: [],
    };
    S.kaarten.push(k);
    S.open = k.id;
    S.opmerkingen = [];
    S.saveStatus = "Nog niet bewaard";
    render();
    const t = document.getElementById("f-titel");
    if (t) t.focus();
  }

  async function verwijderKaart() {
    const k = byId(S.kaarten, S.open);
    if (!k) return;
    if (!confirm(`Mijlpaal ${k.nr || ""} verwijderen? De geschiedenis blijft bewaard.`)) return;
    try {
      if (S.saveStatus !== "Nog niet bewaard") await store.verwijderKaart(k.id);
      S.kaarten = S.kaarten.filter((x) => x.id !== k.id);
      sluitKaart();
      toast("Mijlpaal verwijderd");
    } catch (e) {
      toast("Verwijderen mislukt: " + e.message, true);
    }
  }

  function positieTussen(list, index) {
    // list: cards in the target column in order, index: insertion point.
    const before = list[index - 1];
    const after = list[index];
    if (!before && !after) return 0;
    if (!before) return after.positie - 10;
    if (!after) return before.positie + 10;
    return (before.positie + after.positie) / 2;
  }

  function exportJSON() {
    const data = {
      geexporteerd_op: new Date().toISOString(),
      aanvangsdatum: aanvangsdatum(),
      mensen: S.mensen.map(({ id, email, naam, organisatie, soort, rol, notities, mag_bewerken, is_beheerder, actief, volgorde }) => ({ id, email, naam, organisatie, soort, rol, notities, mag_bewerken, is_beheerder, actief, volgorde })),
      kaarten: S.kaarten.map((k) => ({ ...k, eigenaar: naamVan(k.eigenaar_id) || null, gedeeld_met: naamVan(k.gedeeld_met_id) || null, streefdatum_berekend: streefdatumVan(k) })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `freehold-mijlpalen-${vandaag()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function importJSON(file) {
    try {
      const data = JSON.parse(await file.text());
      const rows = (data.kaarten || []).map((k) => ({
        id: k.id, nr: k.nr, titel: k.titel, toets: k.toets, afhankelijkheid: k.afhankelijkheid, grond: k.grond,
        eigenaar_id: k.eigenaar_id, gedeeld_groep: !!k.gedeeld_groep, gedeeld_met_id: k.gedeeld_met_id || null,
        periode: k.periode, maand: k.maand, streefdatum: k.streefdatum, kolom: k.kolom || "open", positie: k.positie || 0,
        betrokkenen: k.betrokkenen || [], checklist: k.checklist || [],
      })).filter((k) => k.titel);
      if (!rows.length) { toast("Geen mijlpalen gevonden in het bestand.", true); return; }
      if (!confirm(`${rows.length} mijlpalen inlezen?`)) return;
      await store.importeer(rows);
      await laadAlles();
      render();
      toast(`${rows.length} mijlpalen ingelezen`);
    } catch (e) {
      toast("Inlezen mislukt: " + e.message, true);
    }
  }

  // ------------------------------------------------------------------
  // Event binding (after each render)
  // ------------------------------------------------------------------

  function bind() {
    const q = (sel) => document.querySelector(sel);
    const on = (sel, ev, fn) => { const el = q(sel); if (el) el.addEventListener(ev, fn); };

    // Gate
    on("#gate-form", "submit", async (e) => {
      e.preventDefault();
      const email = q("#gate-email").value.trim();
      S.gate = { status: "Even geduld", err: false, sent: false };
      render();
      try {
        await store.loginMagicLink(email);
        S.gate = { status: `Inloglink verstuurd naar ${email}. Open de mail en klik op de link; dit venster mag dicht.`, err: false, sent: true };
      } catch (err) {
        S.gate = { status: "Versturen mislukt: " + err.message, err: true, sent: false };
      }
      render();
    });
    on("#gate-google", "click", async () => { try { await store.loginGoogle(); } catch (e) { toast(e.message, true); } });
    on("#btn-logout", "click", async () => { await store.logout(); S.sessie = null; S.ik = null; render(); });

    // Nav
    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", async () => {
      S.view = b.dataset.view;
      S.open = null;
      if (S.view === "activiteit") { try { S.activiteit = await store.laadActiviteit(); } catch (e) { toast(e.message, true); } }
      render();
    }));

    // Filters
    document.querySelectorAll(".chip[data-f]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.f, v = b.dataset.v;
      if (f === "gedeeld") S.filters.gedeeld = !S.filters.gedeeld; else S.filters[f] = v;
      render();
    }));
    on("#zoek", "input", (e) => {
      S.filters.zoek = e.target.value;
      const board = q("#board");
      if (board) { board.outerHTML = renderBoard().replace(/^<div class="view">|<\/div>$/g, ""); bindBoard(); }
    });
    on("#btn-lanes", "click", () => { S.lanes = !S.lanes; render(); });
    on("#btn-nieuw", "click", nieuweKaart);

    bindBoard();

    // Drawer
    on("#drawer-close", "click", () => { if (S.saveStatus === "Nog niet bewaard") S.kaarten = S.kaarten.filter((k) => k.id !== S.open); sluitKaart(); });
    on("#drawer-backdrop", "click", () => { if (S.saveStatus === "Nog niet bewaard") S.kaarten = S.kaarten.filter((k) => k.id !== S.open); sluitKaart(); });
    on("#btn-bewaar", "click", bewaarKaart);
    on("#btn-verwijder", "click", verwijderKaart);
    document.querySelectorAll(".drawer [data-k]").forEach((el) => el.addEventListener("input", () => {
      if (S.saveStatus === "Bewaard" || S.saveStatus === "") { S.saveStatus = "Gewijzigd, nog niet bewaard"; const s = q(".drawer .saved"); if (s) { s.textContent = S.saveStatus; s.className = "saved"; } }
      if (el.dataset.k === "maand" && el.value !== "") { const d = q("#f-datum"); if (d) d.value = ""; }
      if (el.dataset.k === "streefdatum" && el.value !== "") { const m = q("#f-maand"); if (m) m.value = ""; }
    }));
    document.querySelectorAll("#betrokkenen .pick").forEach((b) => b.addEventListener("click", async () => {
      const k = byId(S.kaarten, S.open);
      const pid = b.dataset.pid;
      const set = new Set(k.betrokkenen || []);
      if (set.has(pid)) set.delete(pid); else set.add(pid);
      const betrokkenen = [...set];
      if (S.saveStatus === "Nog niet bewaard") { k.betrokkenen = betrokkenen; render(); return; }
      await patchKaart(k.id, { betrokkenen }, "Betrokkene wijzigen");
    }));
    document.querySelectorAll("#checklist li").forEach((li) => {
      const cid = li.dataset.cid;
      const k = byId(S.kaarten, S.open);
      li.querySelector("input").addEventListener("change", async (e) => {
        const checklist = (k.checklist || []).map((c) => (c.id === cid ? { ...c, gedaan: e.target.checked } : c));
        if (S.saveStatus === "Nog niet bewaard") { k.checklist = checklist; render(); return; }
        await patchKaart(k.id, { checklist }, "Checklist");
      });
      const rm = li.querySelector(".rm");
      if (rm) rm.addEventListener("click", async () => {
        const checklist = (k.checklist || []).filter((c) => c.id !== cid);
        if (S.saveStatus === "Nog niet bewaard") { k.checklist = checklist; render(); return; }
        await patchKaart(k.id, { checklist }, "Checklist");
      });
    });
    on("#checklist-add", "submit", async (e) => {
      e.preventDefault();
      const input = e.target.querySelector("input");
      const tekst = input.value.trim();
      if (!tekst) return;
      const k = byId(S.kaarten, S.open);
      const checklist = [...(k.checklist || []), { id: uid(), tekst, gedaan: false }];
      if (S.saveStatus === "Nog niet bewaard") { k.checklist = checklist; render(); return; }
      await patchKaart(k.id, { checklist }, "Checklist");
      const again = q("#checklist-add input"); if (again) again.focus();
    });
    on("#comment-form", "submit", async (e) => {
      e.preventDefault();
      const ta = q("#comment-text");
      const tekst = ta.value.trim();
      if (!tekst) return;
      if (S.saveStatus === "Nog niet bewaard") { toast("Bewaar de mijlpaal eerst.", true); return; }
      try {
        const o = await store.voegOpmerkingToe(S.open, tekst);
        if (!S.opmerkingen.some((x) => x.id === o.id)) S.opmerkingen.push(o);
        render();
      } catch (err) { toast("Plaatsen mislukt: " + err.message, true); }
    });
    document.querySelectorAll(".comment [data-oid]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Opmerking verwijderen?")) return;
      try { await store.verwijderOpmerking(b.dataset.oid); S.opmerkingen = S.opmerkingen.filter((o) => o.id !== b.dataset.oid); render(); }
      catch (err) { toast("Verwijderen mislukt: " + err.message, true); }
    }));
    document.querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = a.dataset.open;
      if (id && byId(S.kaarten, id)) { S.view = "bord"; openKaart(id); }
    }));
    
    // Mensen
    on("#btn-persoon-nieuw", "click", () => { S.persoonModal = { soort: "extern", actief: true, volgorde: 100 }; render(); });
    document.querySelectorAll("[data-edit-persoon]").forEach((b) => b.addEventListener("click", () => { S.persoonModal = { ...persoon(b.dataset.editPersoon) }; render(); }));
    on("#persoon-annuleer", "click", () => { S.persoonModal = null; render(); });
    on("#modal-backdrop", "click", (e) => { if (e.target.id === "modal-backdrop") { S.persoonModal = null; render(); } });
    on("#persoon-form", "submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const p = {
        ...S.persoonModal,
        naam: fd.get("naam").trim(), email: (fd.get("email") || "").trim().toLowerCase() || null, organisatie: (fd.get("organisatie") || "").trim() || null,
        soort: fd.get("soort"), rol: (fd.get("rol") || "").trim() || null, notities: (fd.get("notities") || "").trim() || null,
        mag_bewerken: fd.get("mag_bewerken") === "on", is_beheerder: fd.get("is_beheerder") === "on", actief: fd.get("actief") === "on",
        volgorde: Number(fd.get("volgorde") || 100),
      };
      if (p.is_beheerder) p.mag_bewerken = true;
      try {
        const saved = await store.upsertPersoon(p);
        const i = S.mensen.findIndex((m) => m.id === saved.id);
        if (i >= 0) S.mensen[i] = saved; else S.mensen.push(saved);
        S.persoonModal = null;
        render();
        toast("Bewaard");
      } catch (err) { toast("Bewaren mislukt: " + err.message, true); }
    });

    // Instellingen
    on("#btn-aanvang", "click", async () => {
      const v = q("#s-aanvang").value;
      if (!v) return;
      try { await store.setInstelling("aanvangsdatum", v); S.instellingen.aanvangsdatum = v; render(); toast("Aanvangsdatum bewaard, de streefdatums zijn meegeschoven"); }
      catch (err) { toast("Bewaren mislukt: " + err.message, true); }
    });
    on("#btn-export", "click", exportJSON);
    on("#btn-import", "click", () => q("#import-file").click());
    on("#import-file", "change", (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); });
    document.querySelectorAll(".settings [data-theme]").forEach((b) => b.addEventListener("click", () => {
      const t = b.dataset.theme;
      if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
      try { if (t) localStorage.setItem("fh-theme", t); else localStorage.removeItem("fh-theme"); } catch (_) {}
    }));
  }

  function onKey(e) {
    if (e.key !== "Escape") return;
    if (S.persoonModal) { S.persoonModal = null; render(); return; }
    if (S.open) { if (S.saveStatus === "Nog niet bewaard") S.kaarten = S.kaarten.filter((k) => k.id !== S.open); sluitKaart(); }
  }

  function bindBoard() {
    document.querySelectorAll(".card").forEach((el) => {
      el.addEventListener("click", () => openKaart(el.dataset.id));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openKaart(el.dataset.id); } });
      el.addEventListener("dragstart", (e) => {
        if (!magBewerken()) { e.preventDefault(); return; }
        S.dragId = el.dataset.id;
        el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", el.dataset.id); } catch (_) {}
      });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); S.dragId = null; document.querySelectorAll(".col-list.over").forEach((c) => c.classList.remove("over")); });
    });
    document.querySelectorAll(".col-list").forEach((list) => {
      list.addEventListener("dragover", (e) => { if (!S.dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; list.classList.add("over"); });
      list.addEventListener("dragleave", (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove("over"); });
      list.addEventListener("drop", async (e) => {
        e.preventDefault();
        list.classList.remove("over");
        const id = S.dragId || e.dataTransfer.getData("text/plain");
        if (!id) return;
        const kolom = list.dataset.kolom;
        const col = list.closest(".col");
        const lane = col.dataset.lane;
        const cards = [...list.querySelectorAll(".card")].filter((c) => c.dataset.id !== id);
        let index = cards.length;
        for (let i = 0; i < cards.length; i++) {
          const r = cards[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { index = i; break; }
        }
        const ordered = cards.map((c) => byId(S.kaarten, c.dataset.id)).filter(Boolean);
        const positie = positieTussen(ordered, index);
        const k = byId(S.kaarten, id);
        const patch = { kolom, positie };
        if (lane !== undefined && lane !== "" && k.eigenaar_id !== lane) patch.eigenaar_id = lane;
        if (k.kolom === kolom && Math.abs(k.positie - positie) < 1e-9 && !patch.eigenaar_id) return;
        await patchKaart(id, patch, "Verplaatsen");
      });
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  async function boot() {
    document.addEventListener("keydown", onKey);
    try { const t = localStorage.getItem("fh-theme"); if (t) document.documentElement.setAttribute("data-theme", t); } catch (_) {}
    if (DEMO) {
      store = DemoStore();
    } else {
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        $app.innerHTML = `<div class="gate"><div class="gate-card">${renderLockup(true)}<h1>Nog niet ingesteld</h1><p>Vul <code>supabaseUrl</code> en <code>supabaseAnonKey</code> in <code>config.js</code> in. Voeg <code>?demo</code> toe aan het adres om de voorbeeldweergave te zien.</p></div></div>`;
        return;
      }
      store = SupabaseStore();
    }
    S.sessie = await store.sessie();
    store.onAuth(async (sess) => {
      const was = !!S.sessie;
      S.sessie = sess;
      if (sess && !was) { await start(); } else if (!sess) { S.ik = null; render(); }
    });
    if (S.sessie) await start(); else render();
  }

  async function start() {
    try {
      await laadAlles();
    } catch (e) {
      $app.innerHTML = `<div class="gate"><div class="gate-card">${renderLockup(true)}<h1>Laden mislukt</h1><p>${esc(e.message)}</p><button class="btn" id="btn-logout" type="button">Uitloggen</button></div></div>`;
      bind();
      return;
    }
    render();
    if (S.ik) store.abonneer(onChange, onPeers);
  }

  boot();
})();
