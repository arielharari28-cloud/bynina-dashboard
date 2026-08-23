/**
 * sync.js
 * ---------------------------------------------------------------
 * Trae pedidos y productos desde la API de Tienda Nube, y arma un
 * único array `productos` con toda la info que necesita el
 * dashboard (stock por color/talle, ventas históricas y por
 * período, categoría, fecha de alta). Así el frontend puede
 * filtrar/ordenar libremente sin tener que correr el sync de nuevo.
 *
 * Corre desde GitHub Actions. Nunca expone el token de Tienda Nube
 * ni las credenciales de Firebase al navegador.
 *
 * Variables de entorno requeridas (GitHub Secrets):
 *   TN_STORE_ID, TN_ACCESS_TOKEN, FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT
 * ---------------------------------------------------------------
 */

const admin = require("firebase-admin");

const TN_API_VERSION = "2025-03";
const TN_STORE_ID = process.env.TN_STORE_ID;
const TN_ACCESS_TOKEN = process.env.TN_ACCESS_TOKEN;
const TN_BASE_URL = `https://api.tiendanube.com/${TN_API_VERSION}/${TN_STORE_ID}`;
const USER_AGENT = "ByNINA Dashboard (dashboard@bynina.com.ar)";

const LOW_STOCK_THRESHOLD = 8;

function initFirebase() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  return admin.database();
}

async function tnFetch(path, params = {}) {
  const url = new URL(`${TN_BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        Authentication: `bearer ${TN_ACCESS_TOKEN}`,
        Authorization: `bearer ${TN_ACCESS_TOKEN}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Tienda Nube API: timeout de 20s en ${path}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tienda Nube API error ${res.status} en ${path}: ${body}`);
  }
  return res.json();
}

async function fetchAllPages(path, params = {}) {
  const perPage = 200;
  let page = 1;
  let all = [];
  while (true) {
    const data = await tnFetch(path, { ...params, per_page: perPage, page });
    if (!Array.isArray(data) || data.length === 0) break;
    all = all.concat(data);
    if (data.length < perPage) break;
    page += 1;
  }
  return all;
}

// ---------- Fechas / períodos ----------
// ---------- Fechas / períodos, ancladas a horario Argentina (UTC-3) ----------
// GitHub Actions corre en UTC. Sin este ajuste, "Hoy"/"Ayer"/mes se cortan a
// la medianoche UTC en vez de la medianoche de Buenos Aires, desfasando los
// cortes hasta 3 horas (ventas de la noche caían en el día siguiente, etc).
const ARG_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina no usa horario de verano

function argWallClockParts(date) {
  const shifted = new Date(date.getTime() - ARG_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}
function argMidnight(y, m, d) {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0) + ARG_OFFSET_MS);
}
function startOfDay(date) {
  const { y, m, d } = argWallClockParts(date);
  return argMidnight(y, m, d);
}
function endOfDay(date) {
  return new Date(startOfDay(date).getTime() + 24 * 60 * 60 * 1000 - 1);
}
function daysAgo(n) {
  const d = new Date();
  d.setTime(d.getTime() - n * 24 * 60 * 60 * 1000);
  return d;
}

function buildPeriods() {
  const now = new Date();
  const today = startOfDay(now);
  const { y, m, d } = argWallClockParts(now);

  const yesterdayStart = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayEnd = new Date(today.getTime() - 1);

  const firstOfThisMonth = argMidnight(y, m, 1);
  const firstOfLastMonth = argMidnight(y, m - 1, 1); // Date.UTC normaliza mes negativo
  const lastOfLastMonth = new Date(firstOfThisMonth.getTime() - 1);

  return {
    hoy: { desde: today, hasta: endOfDay(now), dias: 1 },
    ayer: { desde: yesterdayStart, hasta: yesterdayEnd, dias: 1 },
    "7dias": { desde: startOfDay(daysAgo(7)), hasta: endOfDay(now), dias: 7 },
    "15dias": { desde: startOfDay(daysAgo(15)), hasta: endOfDay(now), dias: 15 },
    "30dias": { desde: startOfDay(daysAgo(30)), hasta: endOfDay(now), dias: 30 },
    estemes: { desde: firstOfThisMonth, hasta: endOfDay(now), dias: d },
    mesanterior: { desde: firstOfLastMonth, hasta: lastOfLastMonth, dias: 30 },
  };
}

function previousRange(desde, hasta) {
  const lengthMs = hasta.getTime() - desde.getTime();
  const prevHasta = new Date(desde.getTime() - 1);
  const prevDesde = new Date(prevHasta.getTime() - lengthMs);
  return { desde: prevDesde, hasta: prevHasta };
}

function inRange(dateStr, desde, hasta) {
  const d = new Date(dateStr);
  return d >= desde && d <= hasta;
}

const ESTADOS_VALIDOS = new Set(["paid", "authorized"]);
const ESTADOS_CANCELADOS = new Set(["cancelled"]);
function pedidoCuenta(order) { return !ESTADOS_CANCELADOS.has(order.status); }
function itemsCuentanVenta(order) { return ESTADOS_VALIDOS.has(order.payment_status); }

// ---------- KPIs agregados (para las tarjetas del dashboard) ----------
function calcularKpisPeriodo(orders, desde, hasta) {
  const enRango = orders.filter((o) => inRange(o.created_at, desde, hasta) && pedidoCuenta(o));
  const pagados = enRango.filter(itemsCuentanVenta);

  let unidadesVendidas = 0;
  let facturacionTotal = 0;
  const productosVendidosSet = new Set();
  pagados.forEach((o) => {
    (o.products || []).forEach((li) => {
      unidadesVendidas += Number(li.quantity || 0);
      facturacionTotal += Number(li.price || 0) * Number(li.quantity || 0);
      productosVendidosSet.add(li.product_id);
    });
  });

  const prev = previousRange(desde, hasta);
  const enRangoPrev = orders.filter((o) => inRange(o.created_at, prev.desde, prev.hasta) && pedidoCuenta(o));
  const pagadosPrev = enRangoPrev.filter(itemsCuentanVenta);
  let facturacionAnterior = 0;
  pagadosPrev.forEach((o) => (o.products || []).forEach((li) => {
    facturacionAnterior += Number(li.price || 0) * Number(li.quantity || 0);
  }));

  return {
    pedidos: enRango.length,
    pedidosAnterior: enRangoPrev.length,
    unidadesVendidas,
    productosVendidos: productosVendidosSet.size,
    facturacionTotal,
    facturacionAnterior,
    ticketPromedio: pagados.length > 0 ? facturacionTotal / pagados.length : 0,
  };
}

function calcularPorCategoria(orders, desde, hasta, productMeta, top = 8) {
  const pagados = orders.filter((o) => inRange(o.created_at, desde, hasta) && itemsCuentanVenta(o));
  const acc = new Map();
  pagados.forEach((o) => {
    (o.products || []).forEach((li) => {
      const meta = productMeta.get(li.product_id);
      const categorias = (meta && meta.categorias) || ["Sin categoría"];
      categorias.forEach((categoria) => {
        const prev = acc.get(categoria) || { categoria, unidades: 0, facturacion: 0 };
        prev.unidades += Number(li.quantity || 0);
        prev.facturacion += Number(li.price || 0) * Number(li.quantity || 0);
        acc.set(categoria, prev);
      });
    });
  });
  return Array.from(acc.values()).sort((a, b) => b.unidades - a.unidades).slice(0, top);
}

function calcularPorTalle(orders, desde, hasta, variantMeta, top = 12) {
  const pagados = orders.filter((o) => inRange(o.created_at, desde, hasta) && itemsCuentanVenta(o));
  const acc = new Map();
  pagados.forEach((o) => {
    (o.products || []).forEach((li) => {
      const meta = variantMeta.get(li.variant_id);
      const talle = (meta && meta.talle) || "Sin talle";
      const prev = acc.get(talle) || { talle, unidades: 0, facturacion: 0 };
      prev.unidades += Number(li.quantity || 0);
      prev.facturacion += Number(li.price || 0) * Number(li.quantity || 0);
      acc.set(talle, prev);
    });
  });
  return Array.from(acc.values()).sort((a, b) => b.unidades - a.unidades).slice(0, top);
}

// ---------- Metadata de productos/variantes ----------
function construirMetadata(products) {
  const productMeta = new Map();
  const variantMeta = new Map();

  products.forEach((p) => {
    const categorias = (p.categories || []).map((c) => c.name?.es || c.name).filter(Boolean);
    productMeta.set(p.id, { categorias: categorias.length ? categorias : ["Sin categoría"] });
    (p.variants || []).forEach((v) => {
      variantMeta.set(v.id, {
        productId: p.id,
        color: v.values?.[0]?.es || null,
        talle: v.values?.[1]?.es || v.values?.[0]?.es || null,
      });
    });
  });

  return { productMeta, variantMeta };
}

function calcularPorTag(orders, desde, hasta, productTags, top = 12) {
  const pagados = orders.filter((o) => inRange(o.created_at, desde, hasta) && itemsCuentanVenta(o));
  const acc = new Map();
  pagados.forEach((o) => {
    (o.products || []).forEach((li) => {
      const tags = productTags.get(li.product_id) || [];
      tags.forEach((tag) => {
        const prev = acc.get(tag) || { tag, unidades: 0, facturacion: 0 };
        prev.unidades += Number(li.quantity || 0);
        prev.facturacion += Number(li.price || 0) * Number(li.quantity || 0);
        acc.set(tag, prev);
      });
    });
  });
  return Array.from(acc.values()).sort((a, b) => b.unidades - a.unidades).slice(0, top);
}

// ---------- Ventas por producto: histórico + por período ----------
function construirVentasPorProducto(orders, periods, variantMeta) {
  const ventas = new Map();

  function getEntry(productId) {
    if (!ventas.has(productId)) {
      const porPeriodo = {};
      const colorPorPeriodo = {};
      const tallePorPeriodo = {};
      const variantePorPeriodo = {};
      Object.keys(periods).forEach((k) => {
        porPeriodo[k] = { unidades: 0, facturacion: 0, pedidoIds: new Set() };
        colorPorPeriodo[k] = new Map(); // color -> { color, unidades, facturacion }
        tallePorPeriodo[k] = new Map(); // talle -> { talle, unidades, facturacion }
        variantePorPeriodo[k] = new Map(); // "color / talle" -> { color, talle, variante, unidades, facturacion }
      });
      ventas.set(productId, {
        alltime: { unidades: 0, facturacion: 0, pedidoIds: new Set(), ultimaVenta: null },
        porPeriodo,
        colorPorPeriodo,
        tallePorPeriodo,
        variantePorPeriodo,
      });
    }
    return ventas.get(productId);
  }

  const pagados = orders.filter(itemsCuentanVenta);
  pagados.forEach((o) => {
    const fecha = new Date(o.created_at);
    (o.products || []).forEach((li) => {
      const entry = getEntry(li.product_id);
      const unidades = Number(li.quantity || 0);
      const facturacion = Number(li.price || 0) * unidades;
      const meta = variantMeta.get(li.variant_id) || {};
      const color = meta.color || null;
      const talle = meta.talle || null;

      entry.alltime.unidades += unidades;
      entry.alltime.facturacion += facturacion;
      entry.alltime.pedidoIds.add(o.id);
      if (!entry.alltime.ultimaVenta || fecha > new Date(entry.alltime.ultimaVenta)) {
        entry.alltime.ultimaVenta = o.created_at;
      }

      Object.entries(periods).forEach(([key, { desde, hasta }]) => {
        if (fecha >= desde && fecha <= hasta) {
          entry.porPeriodo[key].unidades += unidades;
          entry.porPeriodo[key].facturacion += facturacion;
          entry.porPeriodo[key].pedidoIds.add(o.id);

          if (color) {
            const cMap = entry.colorPorPeriodo[key];
            const cPrev = cMap.get(color) || { color, unidades: 0, facturacion: 0 };
            cPrev.unidades += unidades;
            cPrev.facturacion += facturacion;
            cMap.set(color, cPrev);
          }
          if (talle) {
            const tMap = entry.tallePorPeriodo[key];
            const tPrev = tMap.get(talle) || { talle, unidades: 0, facturacion: 0 };
            tPrev.unidades += unidades;
            tPrev.facturacion += facturacion;
            tMap.set(talle, tPrev);
          }
          const vKey = `${color || "Sin color"} / ${talle || "Sin talle"}`;
          const vMap = entry.variantePorPeriodo[key];
          const vPrev = vMap.get(vKey) || { color: color || "Sin color", talle: talle || "Sin talle", variante: vKey, unidades: 0, facturacion: 0 };
          vPrev.unidades += unidades;
          vPrev.facturacion += facturacion;
          vMap.set(vKey, vPrev);
        }
      });
    });
  });

  return ventas;
}

function serializarProductos(products, ventasPorProducto, periods) {
  return products.map((p) => {
    const nombre = p.name?.es || p.name;
    const imagen = p.images?.[0]?.src || null;
    const categoriasArr = (p.categories || []).map((c) => c.name?.es || c.name).filter(Boolean);
    const categoria = categoriasArr[0] || "Sin categoría";
    const categorias = categoriasArr.length ? categoriasArr : ["Sin categoría"];
    const publicado = p.published !== false;
    const tags = (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

    const variantes = (p.variants || []).map((v) => {
      const stock = v.stock === null || v.stock === undefined ? null : Number(v.stock);
      const precio = Number(v.price || 0);
      return {
        id: v.id,
        sku: v.sku || null,
        color: v.values?.[0]?.es || null,
        talle: v.values?.[1]?.es || null,
        variante: [v.values?.[0]?.es, v.values?.[1]?.es].filter(Boolean).join(" / ") || "Único",
        stock,
        precio,
      };
    });

    const stockTotal = variantes.reduce((acc, v) => acc + (v.stock || 0), 0);
    const stockValorTotal = variantes.reduce((acc, v) => acc + (v.stock || 0) * (v.precio || 0), 0);

    const colorMap = new Map();
    variantes.forEach((v) => {
      const color = v.color || "Único";
      colorMap.set(color, (colorMap.get(color) || 0) + (v.stock || 0));
    });
    const stockPorColor = Array.from(colorMap.entries())
      .map(([color, stock]) => ({ color, stock }))
      .sort((a, b) => b.stock - a.stock);
    const colorMasStock = stockPorColor.length ? stockPorColor[0] : null;

    const ventas = ventasPorProducto.get(p.id);
    const ventasTotales = ventas
      ? {
          unidades: ventas.alltime.unidades,
          facturacion: ventas.alltime.facturacion,
          pedidos: ventas.alltime.pedidoIds.size,
          ultimaVenta: ventas.alltime.ultimaVenta,
        }
      : { unidades: 0, facturacion: 0, pedidos: 0, ultimaVenta: null };

    const ventasPorPeriodo = {};
    Object.keys(periods).forEach((key) => {
      const v = ventas ? ventas.porPeriodo[key] : null;
      const colorMap = ventas ? ventas.colorPorPeriodo[key] : new Map();
      const talleMap = ventas ? ventas.tallePorPeriodo[key] : new Map();
      const varianteMap = ventas ? ventas.variantePorPeriodo[key] : new Map();

      const coloresVendidos = Array.from(colorMap.values()).sort((a, b) => b.unidades - a.unidades);
      const tallesVendidos = Array.from(talleMap.values()).sort((a, b) => b.unidades - a.unidades);
      const variantesVendidas = Array.from(varianteMap.values()).sort((a, b) => b.unidades - a.unidades);

      ventasPorPeriodo[key] = {
        unidades: v ? v.unidades : 0,
        facturacion: v ? v.facturacion : 0,
        pedidos: v ? v.pedidoIds.size : 0,
        colorMasVendido: coloresVendidos.length ? coloresVendidos[0] : null,
        talleMasVendido: tallesVendidos.length ? tallesVendidos[0] : null,
        coloresVendidos,
        tallesVendidos,
        variantesVendidas,
      };
    });

    return {
      id: p.id,
      producto: nombre,
      imagen,
      categoria,
      categorias,
      tags,
      publicado,
      creado: p.created_at,
      stockTotal,
      stockValorTotal,
      stockPorColor,
      colorMasStock,
      variantes: variantes.sort((a, b) => (a.stock || 0) - (b.stock || 0)),
      ventasTotales,
      ventasPorPeriodo,
    };
  });
}

// ---------- Main ----------
async function main() {
  if (!TN_STORE_ID || !TN_ACCESS_TOKEN) {
    throw new Error("Faltan TN_STORE_ID o TN_ACCESS_TOKEN en el entorno.");
  }

  console.log("Trayendo pedidos de Tienda Nube...");
  const orders = await fetchAllPages("/orders", { created_at_min: daysAgo(95).toISOString() });
  console.log(`Pedidos traídos: ${orders.length}`);

  console.log("Trayendo productos de Tienda Nube...");
  const products = await fetchAllPages("/products");
  console.log(`Productos traídos: ${products.length}`);

  const periods = buildPeriods();
  const periodosDias = {};
  Object.entries(periods).forEach(([k, v]) => (periodosDias[k] = v.dias));

  const { productMeta, variantMeta } = construirMetadata(products);
  const productTags = new Map(products.map((p) => [p.id, (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean)]));

  const kpisPorPeriodo = {};
  const porCategoriaPorPeriodo = {};
  const porTallePorPeriodo = {};
  const porTagPorPeriodo = {};
  Object.entries(periods).forEach(([key, { desde, hasta }]) => {
    kpisPorPeriodo[key] = calcularKpisPeriodo(orders, desde, hasta);
    porCategoriaPorPeriodo[key] = calcularPorCategoria(orders, desde, hasta, productMeta);
    porTallePorPeriodo[key] = calcularPorTalle(orders, desde, hasta, variantMeta);
    porTagPorPeriodo[key] = calcularPorTag(orders, desde, hasta, productTags);
  });

  const ventasPorProducto = construirVentasPorProducto(orders, periods, variantMeta);
  const productos = serializarProductos(products, ventasPorProducto, periods);

  const db = initFirebase();
  const payload = {
    actualizado: new Date().toISOString(),
    periodosDias,
    kpisPorPeriodo,
    porCategoriaPorPeriodo,
    porTallePorPeriodo,
    porTagPorPeriodo,
    productos,
  };

  console.log("Escribiendo en Firebase...");
  await db.ref("dashboard").set(payload);
  console.log("Listo. Dashboard actualizado.");

  // Firebase Admin (Realtime Database) mantiene una conexión abierta; sin
  // este cierre explícito el proceso de Node nunca termina solo y el job
  // de GitHub Actions queda "corriendo" para siempre.
  await admin.app().delete();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error en sync.js:", err);
    process.exit(1);
  });
