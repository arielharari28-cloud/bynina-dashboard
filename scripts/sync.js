/**
 * sync.js
 * ---------------------------------------------------------------
 * Trae pedidos y productos desde la API de Tienda Nube, calcula los
 * KPIs del dashboard (para varios rangos de fecha) y los guarda en
 * Firebase Realtime Database.
 *
 * Corre desde GitHub Actions. Nunca expone el token de Tienda Nube
 * ni las credenciales de Firebase al navegador: todo queda en este
 * proceso server-side, leyendo secretos de variables de entorno.
 *
 * Variables de entorno requeridas (se cargan como GitHub Secrets):
 *   TN_STORE_ID              -> Store ID de Tienda Nube
 *   TN_ACCESS_TOKEN          -> Access Token de la app a medida
 *   FIREBASE_DB_URL          -> URL de la Realtime Database (https://bynina-c1eec-default-rtdb...)
 *   FIREBASE_SERVICE_ACCOUNT -> JSON completo de la service account de Firebase (como string)
 * ---------------------------------------------------------------
 */

const admin = require("firebase-admin");

// ---------- Config ----------
const TN_API_VERSION = "2025-03";
const TN_STORE_ID = process.env.TN_STORE_ID;
const TN_ACCESS_TOKEN = process.env.TN_ACCESS_TOKEN;
const TN_BASE_URL = `https://api.tiendanube.com/${TN_API_VERSION}/${TN_STORE_ID}`;
const USER_AGENT = "ByNINA Dashboard (dashboard@bynina.com.ar)";

// Umbral para "últimas unidades" (alerta de stock bajo)
const LOW_STOCK_THRESHOLD = 8;
// Umbral de días sin venta para aparecer en "Sin ventas recientes"
const SIN_VENTAS_DIAS = 14;

// ---------- Firebase init ----------
function initFirebase() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  return admin.database();
}

// ---------- Tienda Nube fetch helpers ----------
async function tnFetch(path, params = {}) {
  const url = new URL(`${TN_BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  // Timeout de seguridad: si Tienda Nube no responde en 20s, cortamos
  // el pedido en vez de dejar el proceso colgado esperando para siempre.
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
    if (err.name === "AbortError") {
      throw new Error(`Tienda Nube API: timeout de 20s en ${path}`);
    }
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

// Trae TODAS las páginas de un recurso (orders o products)
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
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function buildPeriods() {
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = daysAgo(1);
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  return {
    hoy: { desde: today, hasta: endOfDay(now) },
    ayer: { desde: startOfDay(yesterday), hasta: endOfDay(yesterday) },
    "7dias": { desde: startOfDay(daysAgo(7)), hasta: endOfDay(now) },
    "15dias": { desde: startOfDay(daysAgo(15)), hasta: endOfDay(now) },
    "30dias": { desde: startOfDay(daysAgo(30)), hasta: endOfDay(now) },
    estemes: { desde: startOfDay(firstOfThisMonth), hasta: endOfDay(now) },
    mesanterior: { desde: startOfDay(firstOfLastMonth), hasta: endOfDay(lastOfLastMonth) },
  };
}

// Para el "anterior" (comparación tipo "vs 1.711 anterior") tomamos un
// rango previo de igual longitud, inmediatamente antes del rango actual.
function previousRange(desde, hasta) {
  const lengthMs = hasta.getTime() - desde.getTime();
  const prevHasta = new Date(desde.getTime() - 1);
  const prevDesde = new Date(prevHasta.getTime() - lengthMs);
  return { desde: prevDesde, hasta: prevHasta };
}

// ---------- Cálculo de KPIs ----------
// Estados de pedido que cuentan como venta real (ajustable si Tienda Nube
// usa otros nombres de estado en tu cuenta).
const ESTADOS_VALIDOS = new Set(["paid", "authorized"]); // payment_status
const ESTADOS_CANCELADOS = new Set(["cancelled"]);

function pedidoCuenta(order) {
  if (ESTADOS_CANCELADOS.has(order.status)) return false;
  return true; // se puede afinar luego según cómo Ariel quiera contar "pedido"
}

function itemsCuentanVenta(order) {
  // Solo contamos unidades/productos de pedidos pagados para no inflar
  // con carritos abandonados o pedidos pendientes de pago.
  return ESTADOS_VALIDOS.has(order.payment_status);
}

function inRange(dateStr, desde, hasta) {
  const d = new Date(dateStr);
  return d >= desde && d <= hasta;
}

function calcularFacturacion(pagados) {
  let total = 0;
  pagados.forEach((o) => {
    (o.products || []).forEach((li) => {
      total += Number(li.price || 0) * Number(li.quantity || 0);
    });
  });
  return total;
}

function calcularKpisPeriodo(orders, desde, hasta) {
  const enRango = orders.filter((o) => inRange(o.created_at, desde, hasta) && pedidoCuenta(o));
  const pagados = enRango.filter(itemsCuentanVenta);

  let unidadesVendidas = 0;
  const productosVendidosSet = new Set();
  pagados.forEach((o) => {
    (o.products || []).forEach((li) => {
      unidadesVendidas += Number(li.quantity || 0);
      productosVendidosSet.add(li.product_id);
    });
  });

  const facturacionTotal = calcularFacturacion(pagados);
  const ticketPromedio = pagados.length > 0 ? facturacionTotal / pagados.length : 0;

  const prev = previousRange(desde, hasta);
  const enRangoPrev = orders.filter((o) => inRange(o.created_at, prev.desde, prev.hasta) && pedidoCuenta(o));
  const pagadosPrev = enRangoPrev.filter(itemsCuentanVenta);
  const facturacionAnterior = calcularFacturacion(pagadosPrev);

  return {
    pedidos: enRango.length,
    pedidosAnterior: enRangoPrev.length,
    unidadesVendidas,
    productosVendidos: productosVendidosSet.size,
    productosVendidosIds: Array.from(productosVendidosSet),
    facturacionTotal,
    facturacionAnterior,
    ticketPromedio,
  };
}

function calcularMasVendidos(orders, desde, hasta, top = 20) {
  const pagados = orders.filter(
    (o) => inRange(o.created_at, desde, hasta) && itemsCuentanVenta(o)
  );
  const acc = new Map(); // product_id -> {name, image, unidades, facturacion}
  pagados.forEach((o) => {
    (o.products || []).forEach((li) => {
      const key = li.product_id;
      const prev = acc.get(key) || {
        producto: li.name,
        unidades: 0,
        facturacion: 0,
        imagen: li.image?.src || null,
      };
      prev.unidades += Number(li.quantity || 0);
      prev.facturacion += Number(li.price || 0) * Number(li.quantity || 0);
      acc.set(key, prev);
    });
  });
  // Devolvemos ordenado por unidades por default; el frontend puede
  // reordenar localmente por facturación sin pedir datos de nuevo.
  return Array.from(acc.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.unidades - a.unidades)
    .slice(0, top);
}

function calcularStockYAlertas(products) {
  // Agrupado por producto: cada producto tiene un stock total y su lista
  // de variantes adentro (para "agrupar por variantes" en el dashboard).
  const stockPorProducto = [];
  const ultimasUnidades = [];

  products.forEach((p) => {
    const nombre = p.name?.es || p.name;
    const imagen = p.images?.[0]?.src || null;
    const variantes = (p.variants || []).map((v) => {
      const stock = v.stock === null || v.stock === undefined ? null : Number(v.stock);
      return {
        sku: v.sku || null,
        variante: [v.values?.[0]?.es, v.values?.[1]?.es].filter(Boolean).join(" / ") || "Único",
        stock,
      };
    });

    const stockTotal = variantes.reduce((acc, v) => acc + (v.stock || 0), 0);

    stockPorProducto.push({
      producto: nombre,
      imagen,
      stockTotal,
      variantes: variantes.sort((a, b) => (a.stock || 0) - (b.stock || 0)),
    });

    variantes.forEach((v) => {
      if (v.stock !== null && v.stock > 0 && v.stock <= LOW_STOCK_THRESHOLD) {
        ultimasUnidades.push({
          producto: nombre,
          variante: v.variante,
          unidades: v.stock,
          imagen,
        });
      }
    });
  });

  stockPorProducto.sort((a, b) => a.stockTotal - b.stockTotal);
  ultimasUnidades.sort((a, b) => a.unidades - b.unidades);
  return { stockPorProducto, ultimasUnidades };
}

function calcularSinVentas(products, orders) {
  const now = new Date();
  const desdeCorte = daysAgo(SIN_VENTAS_DIAS);

  // Última fecha de venta pagada por producto
  const ultimaVenta = new Map();
  orders
    .filter(itemsCuentanVenta)
    .forEach((o) => {
      (o.products || []).forEach((li) => {
        const fecha = new Date(o.created_at);
        const actual = ultimaVenta.get(li.product_id);
        if (!actual || fecha > actual) ultimaVenta.set(li.product_id, fecha);
      });
    });

  const sinVentas = [];
  let sinVentasCount = 0;

  products.forEach((p) => {
    const ultima = ultimaVenta.get(p.id);
    const tieneStock = (p.variants || []).some((v) => Number(v.stock || 0) > 0);
    if (!tieneStock) return; // no tiene sentido alertar si no hay stock

    if (!ultima) {
      sinVentasCount += 1;
      sinVentas.push({
        producto: p.name?.es || p.name,
        imagen: p.images?.[0]?.src || null,
        dias: null, // nunca vendió
      });
    } else if (ultima < desdeCorte) {
      const dias = Math.floor((now - ultima) / (1000 * 60 * 60 * 24));
      sinVentasCount += 1;
      sinVentas.push({
        producto: p.name?.es || p.name,
        imagen: p.images?.[0]?.src || null,
        dias,
      });
    }
  });

  sinVentas.sort((a, b) => (b.dias ?? 99999) - (a.dias ?? 99999));
  return { sinVentasCount, sinVentasRecientes: sinVentas.slice(0, 20) };
}

// ---------- Main ----------
async function main() {
  if (!TN_STORE_ID || !TN_ACCESS_TOKEN) {
    throw new Error("Faltan TN_STORE_ID o TN_ACCESS_TOKEN en el entorno.");
  }

  console.log("Trayendo pedidos de Tienda Nube...");
  const orders = await fetchAllPages("/orders", {
    // Traemos los últimos ~90 días de pedidos, suficiente para todos los
    // rangos del dashboard (incluido "mes anterior").
    created_at_min: daysAgo(95).toISOString(),
  });
  console.log(`Pedidos traídos: ${orders.length}`);

  console.log("Trayendo productos de Tienda Nube...");
  const products = await fetchAllPages("/products");
  console.log(`Productos traídos: ${products.length}`);

  const periods = buildPeriods();
  const kpisPorPeriodo = {};
  const masVendidosPorPeriodo = {};

  Object.entries(periods).forEach(([key, { desde, hasta }]) => {
    kpisPorPeriodo[key] = calcularKpisPeriodo(orders, desde, hasta);
    masVendidosPorPeriodo[key] = calcularMasVendidos(orders, desde, hasta);
  });

  const { stockPorProducto, ultimasUnidades } = calcularStockYAlertas(products);
  const { sinVentasCount, sinVentasRecientes } = calcularSinVentas(products, orders);

  const db = initFirebase();
  const payload = {
    actualizado: new Date().toISOString(),
    kpisPorPeriodo,
    masVendidosPorPeriodo,
    ultimasUnidades,
    stockPorProducto,
    sinVentas: { total: sinVentasCount, recientes: sinVentasRecientes },
  };

  console.log("Escribiendo en Firebase...");
  await db.ref("dashboard").set(payload);
  console.log("Listo. Dashboard actualizado.");

  // IMPORTANTE: Firebase Admin (Realtime Database) mantiene una conexión
  // abierta tipo socket para poder escuchar cambios en vivo. Sin este
  // cierre explícito, el proceso de Node nunca termina solo, y el job
  // de GitHub Actions queda "corriendo" para siempre aunque ya haya
  // escrito todo correctamente.
  await admin.app().delete();
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error en sync.js:", err);
    process.exit(1);
  });
