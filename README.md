# ByNINA Dashboard

Dashboard de ventas y stock de ByNINA, con datos en vivo desde Tienda Nube.
Mismo patrón que `bynina-fabrica` y `bynina-control`: HTML simple + Firebase +
GitHub Pages. La diferencia acá es que los datos no se cargan a mano —
un robot (GitHub Actions) los trae automáticamente cada 3 horas.

## Cómo está armado (en criollo)

```
Tienda Nube (API)  →  GitHub Actions (robot que corre solo)  →  Firebase
                                                                     ↓
                                                     index.html (lee de Firebase)
```

El token de Tienda Nube **nunca** toca el HTML ni el navegador. Vive
únicamente como "Secret" de GitHub, que es un lugar cifrado que ni
vos podés volver a ver una vez guardado (por eso lo pediste guardar
aparte antes).

## Paso 1 — Crear el repo en GitHub

1. Andá a github.com → **New repository**
2. Nombre: `bynina-dashboard`
3. Público o privado, como prefieras (privado es más prolijo para esto)
4. Subí todos los archivos de esta carpeta tal cual están

## Paso 2 — Activar GitHub Pages

1. En el repo → **Settings** → **Pages**
2. Source: rama `main`, carpeta `/ (root)`
3. Guardar. En unos minutos el dashboard va a estar en
   `https://arielharari28-cloud.github.io/bynina-dashboard/`

## Paso 3 — Crear la Service Account de Firebase

Esto es lo que le da permiso al robot (GitHub Actions) para escribir
en Firebase de forma segura, sin exponer nada al público.

1. Andá a [Firebase Console](https://console.firebase.google.com/) → proyecto `bynina-c1eec`
2. ⚙️ **Configuración del proyecto** → pestaña **Cuentas de servicio**
3. Click en **Generar nueva clave privada** → se descarga un archivo `.json`
4. **Guardá ese archivo en un lugar seguro** (nunca lo subas al repo)

## Paso 4 — Cargar los Secrets en GitHub

En el repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
Crear estos 4 secrets:

| Nombre | Valor |
|---|---|
| `TN_STORE_ID` | Tu Store ID de Tienda Nube |
| `TN_ACCESS_TOKEN` | El Access Token que ya generaste |
| `FIREBASE_DB_URL` | La URL de tu Realtime Database (la ves en Firebase Console → Realtime Database, arriba de todo, algo tipo `https://bynina-c1eec-default-rtdb.firebaseio.com`) |
| `FIREBASE_SERVICE_ACCOUNT` | Abrí el archivo `.json` del Paso 3 con el Bloc de notas, copiá **todo** el contenido y pegalo acá tal cual |

## Paso 5 — Actualizar las reglas de Firebase

Como el proyecto Firebase (`bynina-c1eec`) ya tiene reglas para
`fabrica` y `control`, hay que **agregar** la sección `dashboard` sin
borrar lo que ya existe.

1. Firebase Console → **Realtime Database** → pestaña **Reglas**
2. Buscá el bloque de arriba de todo (`"rules": { ... }`)
3. Adentro de `"rules"`, agregá esta sección (junto a las que ya tengas
   de fabrica/control, no en lugar de ellas):

```json
"dashboard": {
  ".read": true,
  ".write": "auth != null && auth.admin === true"
}
```

Esto permite que el dashboard **lea** los datos sin login (para que
sea simple de usar), pero **solo la Service Account puede escribir**
— nadie desde afuera puede modificar los números.

## Paso 6 — Completar el `firebaseConfig` del dashboard

En `index.html`, hay que reemplazar `"TU_API_KEY"` por la API Key
pública de tu proyecto Firebase (esta SÍ es pública, no es secreta —
es la misma que ya usan fabrica/control):

1. Firebase Console → ⚙️ **Configuración del proyecto** → **Tus apps**
2. Si ya hay una app web registrada (probablemente sí, de fabrica o
   control), copiá el `apiKey` de ahí
3. Pegalo en el archivo `index.html`, línea del `firebaseConfig`

## Paso 7 — Probar el sync manualmente

1. En el repo → pestaña **Actions**
2. Click en el workflow **"Sync ByNINA Dashboard"**
3. Botón **"Run workflow"** → **Run workflow**
4. Esperá ~1 minuto, refresh — si salió todo verde, ya hay datos en
   Firebase y el dashboard los va a mostrar
5. Si sale en rojo, click adentro para ver el error (casi siempre es
   un secret mal copiado o un permiso que faltó tildar en Tienda Nube)

A partir de ahí, corre solo cada 3 horas. El botón "Actualizar ahora"
del dashboard por ahora solo refresca la vista — conectarlo para que
dispare la Action con un click es un paso opcional que se agrega
después si lo querés.

## Ajustes que probablemente quieras hacer después

Todos estos son parámetros editables al principio de `scripts/sync.js`:

- `LOW_STOCK_THRESHOLD` (hoy en 8): a partir de qué cantidad de stock
  un producto aparece en "Últimas unidades"
- `SIN_VENTAS_DIAS` (hoy en 14): a partir de cuántos días sin vender
  un producto aparece en "Sin ventas recientes"
- `ESTADOS_VALIDOS`: qué estados de pago de Tienda Nube cuentan como
  "venta real" para las unidades/productos vendidos

## Nota de seguridad

- El Access Token de Tienda Nube y la Service Account de Firebase
  **nunca** deben pegarse en el HTML, en un commit, ni acá en el chat.
- Si en algún momento sospechás que alguno de los dos quedó expuesto,
  se puede revocar y regenerar sin romper nada (Tienda Nube: sección
  Aplicaciones a medida → eliminar y crear de nuevo. Firebase: Cuentas
  de servicio → generar nueva clave, la vieja se puede deshabilitar).
