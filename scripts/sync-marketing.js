/**
 * sync-marketing.js
 * ---------------------------------------------------------------
 * Trae una vez por día:
 *   1. Meta Ads: inversión y ventas informadas por Meta, por día y por anuncio.
 *   2. Instagram: estadísticas de la cuenta y de las últimas publicaciones.
 *   3. Tienda Nube: facturación por día y por categoría (para el ROAS real)
 *      y grupos de clientas (nuevas, recompran, fieles, enfriándose, perdidas).
 *
 * Escribe todo en Firebase, nodo `dashboard_marketing`.
 * IMPORTANTE: solo se guardan números agregados. Ningún nombre, mail ni
 * teléfono de clientas sale de este script.
 *
 * Variables de entorno (GitHub Secrets):
 *   META_ACCESS_TOKEN          token del usuario del sistema "dashboard"
 *   META_APP_SECRET            (opcional) clave secreta de la app "By Nina Datos"
 *   META_AD_ACCOUNT_IDS        (opcional) ids separados por coma; si falta, usa
 *                              todas las cuentas asignadas al usuario del sistema
 *   TN_STORE_ID, TN_ACCESS_TOKEN, FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT
 *                              (los mismos que ya usa sync.js)
 * ---------------------------------------------------------------
 */

const crypto = require("crypto");

// ================== AJUSTES ==================
const META_API_VERSION = "v23.0";
const DIAS_META = 95;            // días de pauta que se traen (alcanza para 30 + comparar y "Este mes")
const IG_PUBLICACIONES = 40;     // últimas publicaciones de Instagram a analizar
const DIAS_CLIENTAS = 400;       // historial de pedidos para armar los grupos de clientas

// Grupos de clientas (días desde la última compra)
const ACTIVA_HASTA = 60;         // compró hace 60 días o menos → activa
const ENFRIANDO_HASTA = 120;     // 61 a 120 días → enfriándose; más → perdida
const FIEL_MIN_COMPRAS = 4;      // compras en los últimos 365 días para ser "fiel"

// Cómo se reconoce el desglose de cada anuncio. Se busca en el nombre de la
// campaña, del conjunto y del anuncio (sin mayúsculas ni acentos).
// El orden importa: gana el primero que coincida.
const DESGLOSES = [
  // "conjunto" no se usa como clave: Meta llama "conjunto de anuncios" a cada grupo y se confundiría
  { id: "looks", nombre: "Looks", claves: ["look", "outfit"] },
  { id: "basicos", nombre: "Básicos", claves: ["basico", "basic"] },
  { id: "tendencias", nombre: "Tendencias", claves: ["tendencia", "trend"] },
  { id: "categoria", nombre: "Categoría", claves: [] }, // se asigna si se reconoce una categoría (abajo)
];
// Palabra en el nombre del anuncio → categoría de Tienda Nube (para comparar contra ventas de esa categoría)
const CATEGORIA_CLAVES = [
  ["remera", "Remeras"], ["top", "Tops"], ["short", "Shorts"], ["pantalon", "Pantalones"],
  ["jean", "Jeans"], ["buzo", "Buzos"], ["sweater", "Sweaters"], ["tejido", "Tejidos"],
  ["campera", "Camperas"], ["gamulan", "Gamulanes"], ["vestido", "Vestidos"], ["body", "Body"],
  ["camisa", "Camisas"], ["blazer", "Blazers"], ["accesorio", "Accesorios"],
];
// ==============================================

const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const TN_STORE_ID = process.env.TN_STORE_ID;
const TN_ACCESS_TOKEN = process.env.TN_ACCESS_TOKEN;
const TN_BASE_URL = `https://api.tiendanube.com/2025-03/${TN_STORE_ID}`;
const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;
const DIA = 24 * 60 * 60 * 1000;
const ARG_OFFSET_MS = 3 * 60 * 60 * 1000;

// ---------- utilidades ----------
function normalizar(s) {
  return (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function fechaAR(date) {
  const s = new Date(new Date(date).getTime() - ARG_OFFSET_MS);
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}-${String(s.getUTCDate()).padStart(2, "0")}`;
}
function hoyAR() { return fechaAR(new Date()); }
function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diasEntre(a, b) { return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / DIA); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function redondear(n, d = 2) { const f = 10 ** d; return Math.round(n * f) / f; }
// Firebase no acepta . # $ / [ ] en las claves
function claveFB(s) { return String(s).replace(/[.#$/\[\]]/g, "_"); }

// ---------- Meta Graph API ----------
function appsecretProof() {
  if (!META_APP_SECRET) return null;
  return crypto.createHmac("sha256", META_APP_SECRET).update(META_TOKEN).digest("hex");
}

async function graphGet(pathOrUrl, params = {}) {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(`${GRAPH}${pathOrUrl}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : v);
  });
  url.searchParams.delete("access_token"); // el token va siempre en el header, nunca en la URL
  const proof = appsecretProof();
  if (proof) url.searchParams.set("appsecret_proof", proof);

  for (let intento = 1; intento <= 3; intento++) {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${META_TOKEN}` } });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const err = body.error || {};
    // 4, 17, 32, 613, 80000-80014: límites de uso → esperar y reintentar
    const esLimite = [4, 17, 32, 613].includes(err.code) || (err.code >= 80000 && err.code <= 80014);
    if (esLimite && intento < 3) { await new Promise((r) => setTimeout(r, 30000 * intento)); continue; }
    const e = new Error(`Meta API ${res.status} (${err.code || "?"}): ${err.message || "error"} en ${url.pathname}`);
    e.meta = err;
    throw e;
  }
}

async function graphTodas(path, params = {}) {
  let out = [];
  let body = await graphGet(path, params);
  out = out.concat(body.data || []);
  let paginas = 1;
  while (body.paging && body.paging.next && paginas < 200) {
    body = await graphGet(body.paging.next);
    out = out.concat(body.data || []);
    paginas += 1;
  }
  return out;
}

// Valor de compras informado por Meta. Se toma UNA sola fuente para no duplicar.
const TIPOS_COMPRA = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
function valorAccion(lista, tipos) {
  const arr = Array.isArray(lista) ? lista : [];
  for (const t of tipos) {
    const a = arr.find((x) => x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
}

function clasificarAnuncio(campania, conjunto, anuncio) {
  const texto = normalizar(`${campania} | ${conjunto} | ${anuncio}`);
  let categoria = null;
  for (const [clave, cat] of CATEGORIA_CLAVES) {
    if (new RegExp(`\\b${clave}`).test(texto)) { categoria = cat; break; }
  }
  for (const d of DESGLOSES) {
    if (d.claves.some((c) => new RegExp(`\\b${c}`).test(texto))) return { desglose: d.id, categoria };
  }
  if (categoria) return { desglose: "categoria", categoria };
  return { desglose: "otro", categoria: null };
}

async function syncMeta() {
  let cuentas;
  if (process.env.META_AD_ACCOUNT_IDS) {
    const ids = process.env.META_AD_ACCOUNT_IDS.split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => (s.startsWith("act_") ? s : `act_${s}`));
    cuentas = await Promise.all(ids.map((id) => graphGet(`/${id}`, { fields: "id,name,currency,account_status" })));
  } else {
    cuentas = await graphTodas("/me/adaccounts", { fields: "id,name,currency,account_status", limit: 100 });
  }
  console.log(`Meta: ${cuentas.length} cuenta(s) publicitaria(s): ${cuentas.map((c) => c.name).join(", ")}`);

  const hasta = hoyAR();
  const desde = sumarDias(hasta, -DIAS_META);
  const porDia = {};        // fecha → { inversion, ventasMeta, compras, clics, impresiones }
  const porDiaDesglose = {}; // fecha → desglose → { inversion, ventasMeta, compras }
  const anuncios = {};       // adId → info + porDia
  const cuentasOut = [];

  for (const c of cuentas) {
    cuentasOut.push({ id: c.id, nombre: c.name, moneda: c.currency || null, estado: c.account_status ?? null });
    const filas = await graphTodas(`/${c.id}/insights`, {
      level: "ad",
      time_increment: 1,
      time_range: { since: desde, until: hasta },
      fields: "date_start,campaign_name,adset_name,ad_name,ad_id,spend,impressions,clicks,actions,action_values",
      limit: 500,
    });
    console.log(`Meta: ${c.name} → ${filas.length} filas de anuncio por día`);

    filas.forEach((f) => {
      const fecha = f.date_start;
      const inversion = num(f.spend);
      const ventasMeta = valorAccion(f.action_values, TIPOS_COMPRA);
      const compras = valorAccion(f.actions, TIPOS_COMPRA);
      const { desglose, categoria } = clasificarAnuncio(f.campaign_name, f.adset_name, f.ad_name);

      const d = porDia[fecha] || (porDia[fecha] = { inversion: 0, ventasMeta: 0, compras: 0, clics: 0, impresiones: 0 });
      d.inversion += inversion; d.ventasMeta += ventasMeta; d.compras += compras;
      d.clics += num(f.clicks); d.impresiones += num(f.impressions);

      const dd = porDiaDesglose[fecha] || (porDiaDesglose[fecha] = {});
      const k = desglose === "categoria" ? `cat_${claveFB(categoria)}` : desglose;
      const e = dd[k] || (dd[k] = { inversion: 0, ventasMeta: 0, compras: 0 });
      e.inversion += inversion; e.ventasMeta += ventasMeta; e.compras += compras;

      const a = anuncios[f.ad_id] || (anuncios[f.ad_id] = {
        id: f.ad_id, cuenta: c.name, campania: f.campaign_name || "", conjunto: f.adset_name || "",
        anuncio: f.ad_name || "", desglose, categoria, miniatura: null, porDia: {},
      });
      a.porDia[fecha] = { i: redondear(inversion), v: redondear(ventasMeta), c: compras };
    });
  }

  // Miniaturas de los anuncios con inversión en los últimos 30 días (de a 50 por pedido)
  const desde30 = sumarDias(hasta, -30);
  const conGasto = Object.values(anuncios).filter((a) =>
    Object.entries(a.porDia).some(([f, v]) => f >= desde30 && v.i > 0)).map((a) => a.id);
  for (let i = 0; i < conGasto.length; i += 50) {
    const lote = conGasto.slice(i, i + 50);
    try {
      const res = await graphGet("/", { ids: lote.join(","), fields: "creative{thumbnail_url,image_url}" });
      lote.forEach((id) => {
        const cr = res[id] && res[id].creative;
        if (cr) anuncios[id].miniatura = cr.thumbnail_url || cr.image_url || null;
      });
    } catch (err) {
      console.warn(`Meta: no se pudieron traer miniaturas (${err.message})`);
    }
  }

  // Solo se guardan anuncios que tuvieron inversión en el período
  const anunciosOut = {};
  Object.values(anuncios).forEach((a) => {
    if (Object.values(a.porDia).some((v) => v.i > 0)) anunciosOut[claveFB(a.id)] = a;
  });
  Object.values(porDia).forEach((d) => { d.inversion = redondear(d.inversion); d.ventasMeta = redondear(d.ventasMeta); });
  Object.values(porDiaDesglose).forEach((dd) => Object.values(dd).forEach((e) => {
    e.inversion = redondear(e.inversion); e.ventasMeta = redondear(e.ventasMeta);
  }));

  return {
    cuentas: cuentasOut,
    desde, hasta,
    desgloses: DESGLOSES.map(({ id, nombre }) => ({ id, nombre })).concat([{ id: "otro", nombre: "Sin clasificar" }]),
    porDia,
    porDiaDesglose,
    anuncios: anunciosOut,
  };
}

// ---------- Instagram ----------
// Pide varias métricas y, si Meta rechaza alguna para ese tipo de publicación,
// reintenta de a una para quedarse con las que sí existen.
async function insightsTolerante(path, metricas, extra = {}) {
  try {
    const r = await graphGet(path, { metric: metricas.join(","), ...extra });
    return r.data || [];
  } catch (err) {
    const out = [];
    for (const m of metricas) {
      try { const r = await graphGet(path, { metric: m, ...extra }); out.push(...(r.data || [])); } catch (_) { /* métrica no disponible */ }
    }
    return out;
  }
}
function valorInsight(arr, nombre) {
  const m = arr.find((x) => x.name === nombre);
  if (!m) return null;
  if (m.total_value && m.total_value.value != null) return num(m.total_value.value);
  if (Array.isArray(m.values) && m.values.length) return m.values.reduce((s, v) => s + num(v.value), 0);
  return null;
}

async function syncInstagram() {
  const paginas = await graphTodas("/me/accounts", { fields: "id,name,instagram_business_account{id,username,followers_count,media_count}", limit: 100 });
  const ig = paginas.map((p) => p.instagram_business_account).find(Boolean);
  if (!ig) throw new Error("No se encontró una cuenta de Instagram vinculada a las páginas asignadas al usuario del sistema.");
  console.log(`Instagram: @${ig.username}`);

  // Cuenta: últimos 30 días (Meta no permite rangos más largos en un pedido)
  const ahora = Math.floor(Date.now() / 1000);
  const hace30 = ahora - 30 * 24 * 3600;
  const cuentaMetricas = await insightsTolerante(`/${ig.id}/insights`,
    ["reach", "profile_views", "website_clicks", "accounts_engaged", "total_interactions"],
    { period: "day", metric_type: "total_value", since: hace30, until: ahora });
  const alcanceDiario = await insightsTolerante(`/${ig.id}/insights`, ["reach"], { period: "day", since: hace30, until: ahora });
  const porDia = {};
  const serie = alcanceDiario.find((m) => m.name === "reach");
  ((serie && serie.values) || []).forEach((v) => { porDia[fechaAR(v.end_time)] = { alcance: num(v.value) }; });

  // Publicaciones
  const media = [];
  let body = await graphGet(`/${ig.id}/media`, {
    fields: "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count",
    limit: 25,
  });
  media.push(...(body.data || []));
  while (media.length < IG_PUBLICACIONES && body.paging && body.paging.next) {
    body = await graphGet(body.paging.next);
    media.push(...(body.data || []));
  }

  const publicaciones = [];
  for (const m of media.slice(0, IG_PUBLICACIONES)) {
    const tipo = m.media_product_type === "REELS" ? "Reel" : m.media_product_type === "STORY" ? "Historia"
      : m.media_type === "CAROUSEL_ALBUM" ? "Carrusel" : m.media_type === "VIDEO" ? "Video" : "Foto";
    const ins = await insightsTolerante(`/${m.id}/insights`, ["reach", "saved", "shares", "views", "total_interactions", "profile_visits"]);
    publicaciones.push({
      id: m.id,
      tipo,
      fecha: m.timestamp,
      texto: (m.caption || "").slice(0, 140),
      link: m.permalink || null,
      miniatura: m.thumbnail_url || (m.media_type === "IMAGE" || m.media_type === "CAROUSEL_ALBUM" ? m.media_url : null) || null,
      meGusta: num(m.like_count),
      comentarios: num(m.comments_count),
      alcance: valorInsight(ins, "reach"),
      guardados: valorInsight(ins, "saved"),
      compartidos: valorInsight(ins, "shares"),
      reproducciones: valorInsight(ins, "views"),
      interacciones: valorInsight(ins, "total_interactions"),
      visitasPerfil: valorInsight(ins, "profile_visits"),
    });
  }
  console.log(`Instagram: ${publicaciones.length} publicaciones analizadas`);

  return {
    usuario: ig.username,
    seguidores: num(ig.followers_count),
    publicacionesTotales: num(ig.media_count),
    ultimos30: {
      alcance: valorInsight(cuentaMetricas, "reach"),
      visitasPerfil: valorInsight(cuentaMetricas, "profile_views"),
      clicsWeb: valorInsight(cuentaMetricas, "website_clicks"),
      cuentasInteractuaron: valorInsight(cuentaMetricas, "accounts_engaged"),
      interacciones: valorInsight(cuentaMetricas, "total_interactions"),
    },
    porDia,
    publicaciones,
  };
}

// ---------- Tienda Nube ----------
async function tnFetch(path, params = {}) {
  const url = new URL(`${TN_BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  for (let intento = 1; intento <= 3; intento++) {
    const res = await fetch(url.toString(), {
      headers: {
        Authentication: `bearer ${TN_ACCESS_TOKEN}`,
        Authorization: `bearer ${TN_ACCESS_TOKEN}`,
        "User-Agent": "ByNINA Dashboard (dashboard@bynina.com.ar)",
      },
    });
    if (res.status === 404) return []; // Tienda Nube devuelve 404 cuando se pasa de la última página
    if (res.status === 429 && intento < 3) { await new Promise((r) => setTimeout(r, 5000 * intento)); continue; }
    if (!res.ok) throw new Error(`Tienda Nube API ${res.status} en ${path}: ${await res.text()}`);
    return res.json();
  }
}
async function tnTodas(path, params = {}) {
  let page = 1; let all = [];
  while (true) {
    const data = await tnFetch(path, { ...params, per_page: 200, page });
    if (!Array.isArray(data) || data.length === 0) break;
    all = all.concat(data);
    if (data.length < 200) break;
    page += 1;
  }
  return all;
}

const ESTADOS_PAGADOS = new Set(["paid", "authorized"]);
function pedidoVale(o) { return o.status !== "cancelled" && ESTADOS_PAGADOS.has(o.payment_status); }
function idClienta(o) {
  if (o.customer && o.customer.id) return `c${o.customer.id}`;
  const mail = normalizar(o.contact_email || (o.customer && o.customer.email));
  if (mail) return `m${crypto.createHash("sha256").update(mail).digest("hex").slice(0, 16)}`;
  return null;
}
function totalPedido(o) {
  return (o.products || []).reduce((s, li) => s + num(li.price) * num(li.quantity), 0);
}

const CATEGORIAS_REALES = [
  "remeras", "tops", "tejidos", "sweaters", "buzos", "capsula importados", "gamulanes", "camperas",
  "pantalones", "shorts", "body", "jeans", "jean", "accesorios", "blazers", "camisas", "vestidos",
];
function categoriaPrincipal(categorias) {
  const lista = categorias || [];
  const real = lista.find((c) => CATEGORIAS_REALES.some((r) => normalizar(c).includes(r)));
  return real || lista[0] || "Sin categoría";
}

/**
 * Grupos de clientas. Cada clienta cae en un solo grupo:
 *   activa (última compra ≤ ACTIVA_HASTA días): fiel (≥ FIEL_MIN_COMPRAS en 365 días),
 *     si no recompra (2 compras o más), si no nueva (una sola compra)
 *   enfriándose: última compra entre ACTIVA_HASTA+1 y ENFRIANDO_HASTA días
 *   perdida: más de ENFRIANDO_HASTA días
 */
function calcularClientas(pedidos, hoy) {
  const porClienta = new Map();
  pedidos.forEach((o) => {
    const id = idClienta(o);
    if (!id) return;
    const arr = porClienta.get(id) || [];
    arr.push({ fecha: fechaAR(o.created_at), total: totalPedido(o) });
    porClienta.set(id, arr);
  });

  const grupos = { nuevas: 0, recompran: 0, fieles: 0, enfriandose: 0, perdidas: 0 };
  const facturacionGrupo = { nuevas: 0, recompran: 0, fieles: 0, enfriandose: 0, perdidas: 0 };
  const hace365 = sumarDias(hoy, -365);
  let factur365 = 0; let clientas365 = 0;
  const diasHastaSegunda = [];
  let cohorte = 0; let cohorteVolvio = 0;

  porClienta.forEach((compras) => {
    compras.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    const ultima = compras[compras.length - 1].fecha;
    const primera = compras[0].fecha;
    const diasUltima = diasEntre(ultima, hoy);
    const en365 = compras.filter((c) => c.fecha >= hace365);
    const total = compras.reduce((s, c) => s + c.total, 0);

    let g;
    if (diasUltima > ENFRIANDO_HASTA) g = "perdidas";
    else if (diasUltima > ACTIVA_HASTA) g = "enfriandose";
    else if (en365.length >= FIEL_MIN_COMPRAS) g = "fieles";
    else if (compras.length >= 2) g = "recompran";
    else g = "nuevas";
    grupos[g] += 1;
    facturacionGrupo[g] += total;

    if (en365.length) { clientas365 += 1; factur365 += en365.reduce((s, c) => s + c.total, 0); }
    if (compras.length >= 2) {
      const d = diasEntre(primera, compras[1].fecha);
      if (d > 0) diasHastaSegunda.push(d);
    }
    // Recompra a 90 días: clientas cuya primera compra fue hace 90 a 180 días
    const diasPrimera = diasEntre(primera, hoy);
    if (diasPrimera >= 90 && diasPrimera <= 180) {
      cohorte += 1;
      if (compras.some((c, i) => i > 0 && diasEntre(primera, c.fecha) <= 90 && diasEntre(primera, c.fecha) > 0)) cohorteVolvio += 1;
    }
  });

  diasHastaSegunda.sort((a, b) => a - b);
  const mediana = diasHastaSegunda.length ? diasHastaSegunda[Math.floor(diasHastaSegunda.length / 2)] : null;

  Object.keys(facturacionGrupo).forEach((k) => (facturacionGrupo[k] = Math.round(facturacionGrupo[k])));
  return {
    total: porClienta.size,
    grupos,
    facturacionGrupo,
    tasaRecompra90: cohorte ? redondear(cohorteVolvio / cohorte, 4) : null,
    cohorteRecompra: cohorte,
    medianaDiasSegundaCompra: mediana,
    valorClientaAnio: clientas365 ? Math.round(factur365 / clientas365) : null,
    clientasUltimoAnio: clientas365,
    reglas: { activaHasta: ACTIVA_HASTA, enfriandoHasta: ENFRIANDO_HASTA, fielMinCompras: FIEL_MIN_COMPRAS, historialDias: DIAS_CLIENTAS },
  };
}

function calcularTienda(pedidos, productos, desdeDia) {
  const catPorProducto = new Map(productos.map((p) => [p.id, categoriaPrincipal((p.categories || []).map((c) => (c.name && c.name.es) || c.name).filter(Boolean))]));
  const porDia = {};          // fecha → { facturacion, pedidos }
  const porDiaCategoria = {}; // fecha → categoría → facturación
  pedidos.forEach((o) => {
    const fecha = fechaAR(o.created_at);
    if (fecha < desdeDia) return;
    const d = porDia[fecha] || (porDia[fecha] = { facturacion: 0, pedidos: 0 });
    d.pedidos += 1;
    const dc = porDiaCategoria[fecha] || (porDiaCategoria[fecha] = {});
    (o.products || []).forEach((li) => {
      const f = num(li.price) * num(li.quantity);
      d.facturacion += f;
      const cat = claveFB(catPorProducto.get(li.product_id) || "Sin categoría");
      dc[cat] = Math.round((dc[cat] || 0) + f);
    });
    d.facturacion = Math.round(d.facturacion);
  });
  return { porDia, porDiaCategoria };
}

async function syncTienda() {
  const hoy = hoyAR();
  const desde = new Date(Date.now() - DIAS_CLIENTAS * DIA).toISOString();
  console.log("Tienda Nube: trayendo pedidos para clientas...");
  const pedidos = (await tnTodas("/orders", { created_at_min: desde })).filter(pedidoVale);
  console.log(`Tienda Nube: ${pedidos.length} pedidos pagados`);
  const productos = await tnTodas("/products", { fields: "id,categories" });
  return {
    clientas: calcularClientas(pedidos, hoy),
    tienda: calcularTienda(pedidos, productos, sumarDias(hoy, -DIAS_META)),
  };
}

// ---------- Main ----------
async function main() {
  const admin = require("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  const db = admin.database();

  const errores = {};
  const salida = { actualizado: new Date().toISOString() };

  // Cada fuente es independiente: si una falla, las otras se guardan igual.
  const tareas = [
    ["tiendaNube", syncTienda, !!(TN_STORE_ID && TN_ACCESS_TOKEN)],
    ["meta", syncMeta, !!META_TOKEN],
    ["instagram", syncInstagram, !!META_TOKEN],
  ];
  for (const [nombre, fn, habilitada] of tareas) {
    if (!habilitada) { errores[nombre] = "Falta configurar el secreto"; console.warn(`${nombre}: sin credenciales, se saltea`); continue; }
    try {
      const r = await fn();
      if (nombre === "tiendaNube") { salida.clientas = r.clientas; salida.tienda = r.tienda; }
      else salida[nombre] = r;
      await db.ref(`dashboard_marketing/${nombre === "tiendaNube" ? "clientas" : nombre}`).set(nombre === "tiendaNube" ? r.clientas : r);
      if (nombre === "tiendaNube") await db.ref("dashboard_marketing/tienda").set(r.tienda);
      errores[nombre] = null;
      console.log(`${nombre}: guardado`);
    } catch (err) {
      errores[nombre] = err.message;
      console.error(`${nombre}: ERROR → ${err.message}`);
    }
  }

  await db.ref("dashboard_marketing/estado").set({ actualizado: salida.actualizado, errores });
  await admin.app().delete();
  if (Object.values(errores).every(Boolean)) throw new Error("Fallaron todas las fuentes.");
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("Error en sync-marketing.js:", err.message); process.exit(1); });
}

module.exports = { clasificarAnuncio, calcularClientas, calcularTienda, valorAccion, valorInsight, fechaAR, sumarDias };
