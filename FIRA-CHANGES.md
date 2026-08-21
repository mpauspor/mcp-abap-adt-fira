# mcp-abap-adt-Fira — correcciones sobre el upstream

Fork de `fr0ster/mcp-abap-adt` v8.13.0. Verificado contra **DS4** (`vhfiqds4ci`, mandante 100).

Contexto que condiciona todo: la construcción de URLs ADT vive en el paquete npm
`@mcp-abap-adt/adt-clients@10.1.0`, no en este repo. Las correcciones que tocan
URLs se hacen mediante *bypass* en la capa de handlers, siguiendo el patrón que
ya usaba `handleGetInclude`.

---

## A. Verificación post-escritura

**Nuevo:** `src/lib/verifyWrite.ts`

Los handlers de escritura deducían `success: true` de "no saltó ninguna
excepción", que no es la misma afirmación. `verifySourceWritten()` relee la
fuente y la compara antes de que el handler afirme nada; normaliza finales de
línea y blancos finales para no dar falsos positivos con las reescrituras
inocuas de SAP.

Aplicado a `UpdateProgram` y `UpdateInclude`. **Pendiente:** el resto de
handlers `Update*` (clase, interfaz, DDL, tabla…) siguen sin verificar.

## B. GetSqlQuery — corrupción silenciosa de datos ✅ *causa confirmada en DS4*

**Modificado:** `src/handlers/system/readonly/handleGetSqlQuery.ts`
**Test:** `src/__tests__/unit/parseSqlQueryXml.test.ts` (fixture literal de DS4)

SAP emite las celdas vacías como `<dataPreview:data/>` **autocerrado**. El regex
antiguo (`<data...>(.*?)</data>`) no las capturaba, el array de esa columna
llegaba corto y **todos los valores posteriores subían de fila**.

Reproducción exacta, `SELECT FIELDNAME, CHECKTABLE FROM DD03L WHERE TABNAME = 'E070'`:

| | parser antiguo | realidad |
|---|---|---|
| `CHECKTABLE = 'E070'` | atribuido a `AS4USER` (fila 1) | pertenece a `STRKORR` (fila 9) |
| longitud del array | 1 | 9 |

Reescrito con `XMLParser`. Además: se preservan `""` y `"0"` (antes → `null`),
se decodifican entidades XML, y se conservan los NUMC con ceros a la izquierda.

**Afecta también a `GetTableContents`**, que importa el mismo parser.

### B2. Mensajes de error de SAP

El handler descartaba el cuerpo XML del error. Ahora se extrae
`<exc:exception><message>` y se añade una pista cuando procede.

Hallazgo relevante: **SAP reescribe la consulta**, añadiendo
`INTO TABLE @DATA(LT_RESULT) UP TO <n> ROWS .`. De ahí que:

- Escribir tu propio `INTO`/`UP TO` choque → `"UP" is invalid here (due to grammar).`
- Los nombres de columna duplicados en un JOIN los **rechace SAP**, no el MCP:
  `all names ... must be unique in the select list`. Usa alias (`a~TRKORR AS REQ`).

La respuesta ahora incluye `executed_query` con lo que SAP ejecutó realmente.

> Nota: el parser deduplica nombres de columna repetidos por defensa, pero SAP
> impide que lleguen. No era la causa de la descolocación.

## C. CreateTransport — destino y propietario

**Modificado:** `src/handlers/transport/high/handleCreateTransport.ts`

`createTransport` de adt-clients envolvía el destino en barras
(`tm:target="/QS4/"`) → *"Target '/QS4/' does not exist"*, y pasaba el owner
verbatim → *"User mpaus.op does not exist"*. Ninguno era corregible desde el
handler, así que ahora hace el POST directo.

- Destino como **nombre desnudo** (`QS4`, no `/QS4/`).
- Owner en mayúsculas. En DS4 el usuario real es `MPAUS.OP`, y el `.env` lo
  tiene como `mpaus.op` — de ahí el error.
- Se compara el destino pedido contra el asignado y se **avisa** si SAP degradó
  la orden a LOCAL, en vez de devolver el pedido como si se hubiera aplicado.

✅ **Probado en vivo.** Orden `DS4K901132` creada con `target_system: "QS4"` y
`owner: "MPAUS.OP"` a partir de una entrada en minúsculas.

**Matiz sobre los destinos válidos:** un destino no vale solo por existir en
`TMSCSYS`; tiene que ser destino de la ruta de consolidación *desde este
sistema*. `ITE` existe en el paisaje pero SAP lo rechaza desde DS4
(*"Target 'ITE' does not exist"*). Los destinos válidos para órdenes originadas
en DS4 se ven en `E070` filtrando `TRKORR LIKE 'DS4K%'` → `QS4`.

## D. Includes — no existía ninguna ruta de escritura

**Nuevo:** `src/lib/adt/includeSource.ts`, `src/handlers/include/high/handleUpdateInclude.ts`

Ni este repo ni adt-clients sabían escribir un include: el cliente solo
implementa el GET, y todas sus rutas de escritura apuntan a
`/programs/programs/`. `UpdateProgram` completaba lock/update/unlock sobre el
recurso equivocado y devolvía `success: true` sin escribir nada.

- `UpdateInclude`: lock → PUT → unlock → **verifica releyendo** → activa (opcional).
- `UpdateProgram` ahora **detecta un include y se niega**, remitiendo a `UpdateInclude`.

**Sesión stateful:** ADT ata el lock handle a una sesión ABAP stateful. Sin
`connection.setSessionType('stateful')` el lock se emite en una sesión y el PUT
llega en otra, y SAP responde **423 `ExceptionResourceInvalidLockHandle`**. Se
detectó justo así en la primera prueba en vivo.

✅ **Probado en vivo** (11/11): se crea el include, se escribe v1, se sobrescribe
con v2, la relectura confirma, `UpdateProgram` sobre el include se niega sin
tocar nada, y `PROG/I` activa con `activated: true, checked: true`.

`createIncludeObject()` funciona pero aún no está expuesto como herramienta MCP.

## E. ActivateObjects — includes y módulos de función

**Nuevo:** `src/lib/adt/objectUri.ts`, `src/lib/adt/groupActivation.ts`
**Test:** `src/__tests__/unit/buildObjectUri.test.ts`

`buildObjectUri` de adt-clients tenía tres defectos:

1. Sin caso para `PROG/I` → caía al `default:` y fabricaba `/sap/bc/adt/prog/i/…`.
   Con `PROG` daba `/programs/programs/…` → *"REPORT/PROGRAM statement is missing"*.
2. El `default:` inventaba una ruta en vez de admitir que no conocía el tipo.
3. `FUGR/FF` sin padre usaba el nombre del propio módulo como grupo de funciones.

Además, `handleActivateObject` **descartaba el `uri`** que su propio schema
documentaba, y `activateObjectsGroup` tampoco lo aceptaba.

Ahora: mapa propio con `PROG/I`/`INCL`, error explícito ante un tipo
desconocido, `parent_name` para módulos de función, y `uri` explícito como
válvula de escape.

✅ **Probado en vivo.** `ActivateObjects` con `type: PROG/I` sobre un include
devolvió `activated: true, checked: true, generated: true`, sin rastro del
*"REPORT/PROGRAM statement is missing"*.

### Criterio de éxito de la activación

`handleActivateObject` calculaba `success = activated && checked`, que declara
fallida la activación de un objeto que **ya estaba activo** — SAP responde
`activationExecuted="false"` cuando no hay nada que hacer. Ahora el éxito es la
**ausencia de mensajes de severidad error**, y se distingue "activado" de "no
había nada que activar".

## F. RuntimeRunClass — load obsoleto

**Modificado:** `src/handlers/system/readonly/handleRuntimeRunClass.ts`

SAP ejecuta la versión **activa**. Tras un update sin activar, la ejecución
devuelve la salida de la versión anterior, o falla con *"does not implement
if_oo_adt_classrun~main"*. Parece caché de la herramienta, y no lo es.

Pre-flight que compara `?version=active` con `?version=inactive` y aborta con
un mensaje que nombra la causa real. Desactivable con `skip_activation_check`.

Además, *"does not implement if_oo_adt_classrun~main"* llega con **HTTP 200 y
en el cuerpo**, así que el handler lo devolvía como si fuera la salida del
programa. Ahora se detecta y se distingue la causa leyendo la fuente activa:
interfaz realmente ausente, o load obsoleto.

✅ **Probado en vivo.** El pre-flight detecta los cambios sin activar y rechaza
en lugar de devolver la salida de la versión anterior.

### Load obsoleto: comportamiento de SAP caracterizado (no corregible desde aquí)

Escenario reproducido en DS4: una clase **recién creada** a la que se le añade
`if_oo_adt_classrun` en su primer update queda inejecutable, aunque la
activación informe éxito y la fuente activa declare la interfaz.

| Acción | ¿Refresca el load? |
|---|---|
| Esperar 2 s y reintentar | ❌ no — se implementó, se probó y se descartó |
| `ActivateObjects` sobre clase ya activa (`activationExecuted="false"`) | ❌ no |
| Una activación que **sí activa algo** (`activated: true`) | ✅ sí |
| `UpdateClass(activate:true)` sobre clase ya activada antes | ✅ sí |

Por eso el handler **no reintenta ni activa nada por su cuenta**: sería un
efecto colateral no pedido y, además, no funciona. Informa con precisión y deja
la decisión al usuario.

---

## Fuera de alcance

- **G. Payload de 140 KB.** No hay límite en el servidor (verificado: no existe
  `maxContentLength`/`maxBodyLength` ni en `src/` ni en `@mcp-abap-adt/connection`).
  El techo es la llamada MCP. Requiere diseñar escritura por trozos o por fichero.
- **H. Variantes de report.** Sin handler y sin cobertura en adt-clients.
  Necesita investigar si ADT las expone en este release; la vía realista
  probablemente sea RFC (`RS_VARIANT_*`), que es otro proyecto.

## Estado de verificación

| Corrección | Compila | Test unitario | Probado contra DS4 |
|---|---|---|---|
| A verificación escritura | ✅ | — | ✅ confirma la escritura del include |
| B parser SQL | ✅ | ✅ 17 tests | ✅ **causa confirmada y arreglo validado** |
| B2 errores SAP | ✅ | — | ✅ mensajes de SAP propagados |
| C transportes | ✅ | — | ✅ `DS4K901132` con target QS4 y owner MPAUS.OP |
| D includes | ✅ | — | ✅ 11/11 en batería en vivo |
| E URIs activación | ✅ | ✅ 12 tests | ✅ `PROG/I` activa correctamente |
| F pre-flight clase | ✅ | — | ✅ detecta y rechaza; load obsoleto caracterizado |

Suite unitaria completa: **28 suites / 426 tests en verde**. `tsc` limpio.

## Objetos de prueba en DS4

Creados y **ya borrados** (verificado): include `ZZFIRA_TMP_INC` y clase
`ZZCL_FIRA_TMP_RUN`, ambos en `$TMP`.

⚠️ **Pendiente de borrado manual:** la orden de transporte **`DS4K901132`**
("BORRAR - prueba fork MCP"). ADT no permite borrar órdenes; hay que hacerlo
desde SE01.

---

# Segunda tanda: funcionalidades nuevas

## Verificación de escritura en todos los `Update*` ✅ probado

**Nuevo:** `src/lib/writeVerification.ts` — tabla de descriptores + envoltorio
aplicado en el registro de `HighLevelHandlersGroup`, en lugar de repetir la
misma edición en veinte handlers.

Cubre 13 herramientas: `UpdateClass`, `UpdateInterface`, `UpdateDdl`,
`UpdateMetadataExtension`, `UpdateBehaviorDefinition`,
`UpdateServiceDefinition`, `UpdateTable`, `UpdateStructure`,
`UpdateFunctionModule` y las cuatro secciones locales de clase.

Dos decisiones que conviene conocer:

- **Se lee `/source/main` sin parámetro de versión.** Comprobado en DS4: con
  una activa `ACTIVE_ONE` y una pendiente `PENDING_TWO`, la URL sin cualificar
  devuelve `PENDING_TWO`. Por eso una sola comparación vale tanto con
  `activate:true` como con `false`.
- **Política de fallo asimétrica.** Solo falla duro ante evidencia positiva
  (se lee y difiere). Si la relectura no es posible, degrada a
  `write_verified: false` con el motivo y deja pasar el resultado — una URL mía
  equivocada no debe convertir un update correcto en un error.

**Excluidos a propósito:** `UpdateDomain`, `UpdateDataElement`,
`UpdateMessageClass`, `UpdateServiceBinding`, `UpdateFunctionGroup`. Se editan
por metadatos estructurados, no por fuente; comparar bytes daría discrepancia
en cada escritura correcta. **Siguen sin verificar** — no es que pasen la
verificación.

Corregido sobre la marcha: "local types" es el include **`implementations`**
(CCIMP), no `types`, que SAP rechaza con 400 `uriMappingError`.

## ReleaseTransport ✅ probado

**Nuevo:** `src/handlers/transport/high/handleReleaseTransport.ts`

`AdtRequest` deja `update`/`delete`/`activate`/`check` como stubs que lanzan
excepción, y no ofrece liberación. Esto es código nuevo contra
`POST /sap/bc/adt/cts/transportrequests/{id}/newreleasejobs`.

**La señal de éxito NO es el HTTP.** Probado en DS4: una orden inexistente
devuelve igualmente **200**. Lo que decide es `tm:releasetimestamp` en la
respuesta — vale `0` cuando no se liberó nada. El handler lo usa como señal
principal y corrobora con el estado de la orden.

Guardas verificadas: rechaza una orden ya liberada antes de tocar nada, y
reporta "no se liberó nada" para una inexistente en vez de un falso "aceptado".

## Depurador ABAP ⚠️ listener corregido y probado; falta registrar breakpoints

**Nuevo:** `handlers/debugger/` (Listen, GetStack, GetVariable, Step, Stop) y
`src/lib/adt/debuggerIdentity.ts`.

Expone `AbapDebugger` de adt-clients (endpoints `/sap/bc/adt/debugger/*`), que
estaba implementado y sin herramienta MCP.

`ideId`/`terminalId` se generan **una vez por proceso**: si variaran entre
llamadas, SAP trataría cada petición como de otro IDE y no encontraría la
sesión.

Probado: `DebuggerStop` sin sesión responde correctamente como no-op, y
`DebuggerGetStack` sin sesión da un error accionable. **Sin probar el flujo
real** (listen → breakpoint → stack → step), que necesita disparar código desde
SAP GUI mientras el listener espera.

Ojo: `DebuggerListen` **bloquea** hasta que algo golpea un breakpoint o expira
el timeout.

## abapGit ⚠️ no disponible en DS4

**Nuevo:** `handlers/abapgit/` (ListRepos, GetRepo, GetErrorLog, Link, Pull,
Unlink), envolviendo `AdtAbapGitClient`.

**`/sap/bc/adt/abapgit` devuelve 404 en DS4** — la integración abapGit de ADT
no está instalada en este sistema. El código está completo y compila, pero no
se puede ejercitar aquí. Requiere el componente ADT-abapGit en el servidor.

`AbapGitPull` distingue un timeout **del cliente** de un fallo del servidor: el
job sigue corriendo, y volver a lanzar un pull encima es lo que corrompe el
enlace.

## Batch genérico ❌ descartado — no existe

Propuse exponer el cliente batch para agrupar operaciones ADT y reducir
latencia. **Era incorrecto.** Comprobado en DS4:

- `/sap/bc/adt/batch` → **404, no existe**
- `/sap/bc/adt/debugger/batch` → existe

`AdtClientBatch.batchExecute()` postea a `/sap/bc/adt/debugger/batch`: la
maquinaria batch sirve **solo** para operaciones del depurador. No hay batch
genérico en ADT. La herramienta `BatchGetSources` que había escrito se eliminó.

Esa capacidad sí se aprovecha, pero por dentro del depurador: `DebuggerStep`
usa las variantes batch, que traen el nuevo call stack en el mismo viaje.

### Depurador: dos hallazgos de la prueba en vivo

**1. `adt-clients` usa el verbo HTTP equivocado.** `AbapDebugger.launch()` hace
un `GET` a `/sap/bc/adt/debugger/listeners`. Medido en DS4:

| Verbo | Comportamiento |
|---|---|
| `GET` | 200 con cuerpo vacío en 0,3–0,5 s. No espera, sea cual sea el parámetro `timeout` |
| `POST` | Mantiene la conexión abierta (aguantó 60,4 s hasta agotar el timeout del cliente) |

El listener del cliente **no puede capturar nada**: registra y vuelve.
`handleDebuggerListen` ya no usa `launch()`; hace el POST directo y sube el
timeout HTTP a `timeout_seconds + 15`, porque si no el cliente aborta un
listener que funciona. Si la espera expira, el error indica llamar a
`DebuggerStop` — un abort del cliente deja el listener vivo en el servidor.

**2. Un breakpoint puesto desde SAP GUI es invisible para ADT.** Verificado:
`GET /sap/bc/adt/debugger/breakpoints` y `/breakpoints/vit` devuelven **vacío**
tras ponerlo en el GUI. Es un breakpoint de sesión, lo atiende el debugger
clásico del propio GUI y nunca llega al listener de ADT.

**Falta por tanto un `DebuggerSetBreakpoint`**: `POST` a
`/sap/bc/adt/debugger/breakpoints?checkConflict=` con la relación
`http://www.sap.com/adt/debugger/relations/synchronize` y un cuerpo XML con la
lista de breakpoints. El endpoint y la relación están confirmados en el
discovery; **el esquema del XML aún no**. Sin esa herramienta, el flujo solo
funciona con breakpoints puestos desde Eclipse ADT.

**3. La identidad del depurador debe ser determinista, no aleatoria.**
`ideId`/`terminalId` se generaban al azar por proceso. Consecuencia observada:
un listener registrado como `MCP_ABAP_ADT_1691DC7D` sobrevivió a un
`DebuggerStop` que se identificaba como `MCP_ABAP_ADT_FDC1D45E` — quedó
huérfano en el servidor y hubo que borrarlo a mano con un DELETE explícito.
Un listener huérfano deja la sesión del usuario cautiva en el siguiente
breakpoint.

Ahora la identidad se **deriva** (SHA-256 sobre usuario + URL + mandante), así
que es reproducible entre procesos y un stop siempre encuentra su listener.

---

# Tercera tanda: comparación entre sistemas

Responde a "¿qué custom code de DEV ha llegado ya a QAS/PRD, y qué ha divergido?".

**Nuevo:** `src/lib/adt/secondarySystem.ts` y `handlers/multisystem/` con
`ListSystems`, `CompareObjectAcrossSystems` y `ComparePackageAcrossSystems`.

## Lo que ya existía y se ha reutilizado

No hubo que construir infraestructura: `connectionCache` ya es un `Map` que
admite hasta 100 conexiones; `resolveEnvFilePath()` ya resolvía
`sessions/<nombre>.env` (el flag `--env=` usaba ese esquema para elegir UN
sistema al arrancar); `createTwoFilesPatch` de `diff` ya generaba diffs
unificados en `handleGetObjectVersionDiff`. Solo faltaba componerlos.

## Dos decisiones de diseño

**Solo lectura, por construcción.** Nada en el módulo escribe, bloquea ni
activa. El sistema remoto suele ser justo el que menos quieres tocar.

**No se usa `createAdtClient` para leer fuente.** Esa fábrica lee el
`systemContext` global, cuyo propio comentario dice *"one MCP session always
maps to one SAP system"*, y de ahí saca `isLegacy`, que elige entre `AdtClient`
y `AdtClientLegacy`. Un sistema secundario de otro release usaría la clase
equivocada. Leyendo con `makeAdtRequestWithTimeout` el singleton deja de
importar, y no hace falta refactorizarlo.

## Grupos de funciones: la trampa que casi deja la herramienta inútil

Un `FUGR` **no tiene `/source/main` propio**. Un filtro ingenuo lo descarta — y
en custom code ABAP los grupos de funciones están por todas partes. Medido en
DS4 antes de arreglarlo:

| Paquete | Unidades comparadas (antes) | (después) |
|---|---|---|
| `ZADATST` | **0** | 3 |
| `Z_TALEND_JOIN` | 1 | **8** |

Ahora cada grupo se expande en sus módulos de función
(`/functions/groups/{fg}/fmodules/{fm}/source/main`) y sus includes
(`/functions/groups/{fg}/includes/{inc}/source/main`), ambas rutas verificadas.

## Qué se compara, y qué no

**Fuente, no números de versión.** Los contadores de versión ABAP son locales a
cada sistema: la versión 7 en DEV y la 7 en QAS no guardan relación. Compararlos
no dice nada; comparar el contenido sí.

La ausencia es un **resultado**, no un error: un 404 se reporta como
`only_in_source` ("aún no transportado"), que suele ser justo la pregunta.

Los tipos editados por metadatos (dominios, elementos de datos, clases de
mensajes) se listan en `not_comparable`, nunca se descartan en silencio.

## Estado

✅ **Probado en DS4** definiendo el propio DS4 como sistema secundario
(`ds4self`): objetos reales dan `identical`, uno inexistente da
`missing_in_both`, un sistema desconocido y un tipo desconocido dan errores
accionables con la ruta esperada.

⚠️ **Sin probar contra un sistema realmente distinto** — eso requiere
credenciales de QS4.

⚠️ **TLS es global al proceso** (`TLS_REJECT_UNAUTHORIZED`), no por conexión: el
sistema secundario hereda la configuración de arranque.

## Validado contra el paisaje real DS4 / QS4 / PS4

Tres sistemas registrados en `sessions/`: DS4 (desarrollo, sistema actual),
`qs4` (integración) y `ps4` (producción).

Ejemplo real de análisis de promoción, sobre objetos modificados en DS4 estos
días:

| Objeto | DS4→QS4 | QS4→PS4 | Lectura |
|---|---|---|---|
| `ZCL_SD_ORDER_SERVICE` | different | identical | parado en desarrollo |
| `ZSD_V1427` | different | identical | parado en desarrollo |
| `ZMMSDSOL` | different | identical | parado en desarrollo |
| `ZMM_CL_ENTITY_SERV_ESCANDALLO` | different | different | transporte en vuelo |
| `Z_DETALLADO_NEW` | identical | identical | promovido |

Un detalle contraintuitivo: `ZSD_V1427` es MÁS PEQUEÑO en DS4 (7.822 b) que en
QS4/PS4 (8.201 b) pese a ser más reciente. El tamaño no indica la dirección del
cambio; solo el diff lo dice.

### SICF se activa por nodo, no en bloque

En PS4, `/sap/bc/adt/discovery` y `/sap/bc/adt/core/systeminformation` devuelven
**403**, pero los nodos de objetos (`/sap/bc/adt/oo/classes/…/source/main`,
`/sap/bc/adt/programs/programs/…/source/main`) responden **200** con fuente
real. Conviene no concluir "ADT está cerrado" a partir de un 403 en discovery:
hay que probar el endpoint que se va a usar.

### Escala

El paquete `ZSD` (976 objetos) expande a ~5.800 unidades comparables, porque los
grupos de funciones se despliegan en módulos e includes. A ~0,87 s por unidad
(dos lecturas ADT, concurrencia 6) el paquete entero serían ~85 minutos; con el
tope por defecto de 200, unos 3 minutos. Pendiente: subir concurrencia o
permitir filtrar por tipo de objeto.

### Verificar que un env apunta al sistema que dice

Un fichero de sesión declara `SAP_MASTER_SYSTEM`, pero eso es solo una etiqueta:
nada garantiza que la URL lleve a ese sistema. Para confirmarlo de verdad, una
consulta al propio SAP vía Data Preview:

```sql
SELECT @SY-SYSID AS SID, MANDT, MTEXT FROM T000 WHERE MANDT = @SY-MANDT
```

Devuelve el ID real del sistema y el nombre del mandante. Comprobado en el
paisaje: DS4/100 "Mandante DS4", QS4/100 "Mandante Calidad", PS4/100 "Mandante
Producción". Vale la pena hacerlo al dar de alta un sistema nuevo, sobre todo si
la URL se dedujo de un patrón de nombres.

Ojo con el `Accept` del endpoint: `application/xml` a secas devuelve 406. Hay que
enviar `application/xml, application/vnd.sap.adt.datapreview.table.v1+xml`.

### Qué nodos SICF hacen falta realmente

Las tres herramientas de comparación solo leen fuentes de objetos, así que les
basta con los nodos de objetos (`/sap/bc/adt/oo/classes/…`,
`/sap/bc/adt/programs/…`, `/sap/bc/adt/ddic/…`). NO necesitan
`/sap/bc/adt/discovery`. Comprobado en PS4: funcionaban con discovery aún en
403. Útil para pedir a Basis lo mínimo imprescindible en un sistema productivo.

---

# Cuarta tanda: barrido del paisaje completo

**Nuevo:** `ComparePackageAcrossLandscape` y `src/lib/adt/packageUnits.ts`.

Una sola llamada recorre la cadena de promoción (DS4 → QS4 → PS4) y dice, por
objeto, hasta dónde ha llegado. Antes eran dos llamadas por paquete y cruzar los
resultados a mano.

## Lectura conservadora a propósito

Si un sistema **posterior** coincide con el origen mientras uno **anterior** no,
eso NO es un estado de promoción: significa que alguien tocó algo fuera de la
cadena de transportes. Se marca como `out_of_band` con aviso explícito, en vez
de etiquetarlo "promovido" y esconder justo el problema que interesa encontrar.

Estados: `promoted`, `pending` (con `reached_through` / `pending_from`),
`not_transported`, `out_of_band`, `unreadable`.

## La expansión de grupos de funciones era el cuello de botella

`collectComparableUnits` expandía cada grupo dentro de un bucle secuencial con
`await`: un viaje en serie por grupo **antes** de empezar a comparar. En un
paquete con muchos grupos eso dominaba el tiempo total, muy por encima de las
comparaciones.

Ahora clasifica primero y expande después, en paralelo. Medido sobre `ZSD`,
60 unidades × 3 sistemas:

| | Antes | Después |
|---|---|---|
| Tiempo | 43 s | **15 s** |

Mismo resultado. El orden del paquete se conserva reensamblando por posición.

## Ejemplo real

`ZFIRA` filtrado a `CLAS/OC`: 4.927 objetos en el paquete → 110 clases
comparadas en 21 s (concurrencia 12). **99 promovidas, 11 pendientes**, y entre
ellas `ZCL_IM_ME_PROCESS_REQ_CUST` con `{qs4: identical, ps4: different}` —
llegó a integración y no a producción.

El filtro `object_types` es lo que hace usable un paquete grande: sin él, `ZSD`
expande a ~5.800 unidades.

---

# Quinta tanda: objetos que no caben en una llamada

Cierra el hueco de los ~140 KB de la lista original. `Z_DETALLADO_NEW` en DS4
ocupa **165 KB**: no se podía escribir, y leerlo se comía una porción enorme del
contexto.

**Nuevo:** `src/lib/fileTransfer.ts`, cableado en los dos grupos de handlers.

El servidor MCP corre en la máquina del usuario, así que puede tocar el sistema
de ficheros directamente. Ni el código ni el resultado pasan por la conversación.

| Parámetro | Dónde | Qué hace |
|---|---|---|
| `source_path` | 15 herramientas `Update*` | Lee la fuente de un fichero local |
| `to_file` | Herramientas `Get/Read/List/Search/Compare/Describe/Runtime` | Escribe la salida a disco y devuelve solo un resumen |

Ambos son opcionales: una llamada que no los use se comporta igual que antes.

## Detalles que costaron una iteración cada uno

**El BOM.** Los editores de Windows añaden marca de orden de bytes. Un BOM
delante de `REPORT ...` no es espacio en blanco para el compilador ABAP: produce
un error de sintaxis invisible en el editor que lo creó. Se elimina al leer.
Verificado: fichero de 88 bytes → 85 escritos en SAP.

**Cada handler llama distinto a la fuente.** `GetProgram` la devuelve como
`program_data`, `GetClass` como `source_code`, `GetDdl` como `source`,
`GetInterface` como `interface_data`. Sin reconocerlos, `to_file` escribía el
sobre JSON con el código escapado dentro — inservible para editar. Ahora se
extrae la fuente cuando se reconoce, se escribe entera si no, y el resumen
**siempre dice cuál de las dos cosas hizo**.

**Solo en las herramientas que pueden devolver algo grande.** Añadir dos
propiedades de esquema a las 223 herramientas costaría contexto en cada petición
para comprar una opción que nadie usaría en un borrado.

## Salvaguardas

- No sobrescribe un fichero existente sin `overwrite: true`; el error nombra el
  fichero y su tamaño.
- Rechaza recibir `source_path` y la fuente inline a la vez, en vez de elegir una
  — adivinar mal escribe el código equivocado en SAP.
- Límite de 10 MB al leer.
- Un error del handler no se escribe al fichero del usuario.

## Ciclo de trabajo

```
GetProgram  → to_file=C:	mp\z_det.abap     (165 KB a disco, 6 líneas de vuelta)
   editar el fichero
UpdateProgram → source_path=C:	mp\z_det.abap
```

✅ Probado de extremo a extremo contra DS4, incluidas las cuatro salvaguardas.

---

# Sexta tanda: tests de integración

Las 17 herramientas nuevas tenían **cero** cobertura de integración. Ahora
`npm run test:fira` las ejercita contra el paisaje real.

**Nuevo:** `src/__tests__/integration/fira/` (4 suites) y
`helpers/firaContext.ts`.

| Suite | Cubre |
|---|---|
| `multisystem` | ListSystems y las tres herramientas de comparación |
| `fileTransfer` | `source_path`, `to_file` y las cuatro salvaguardas |
| `includeLifecycle` | Escritura real de includes + la guarda de `UpdateProgram` |
| `toolContracts` | Transportes, depurador y abapGit: guardas y refusals |

## Por qué un helper propio y no `LambdaTester`

El arnés del repo conduce cada test desde un bloque por caso en
`test-config.yaml` — lo correcto para las suites de ciclo de vida de objetos
para las que se construyó. Las herramientas de este fork son casi todas de
lectura y toman sus entradas del paisaje, no de fixtures: añadir quince bloques
de configuración habría sumado ceremonia sin sumar cobertura. `firaContext.ts`
usa la misma carga de config y de entorno, así que un único `test-config.yaml`
sigue gobernándolo todo.

## Qué se afirma, y qué deliberadamente no

**No se fija el contenido de ninguna comparación.** Si `ZSD` está hoy
sincronizado con QS4 es un hecho sobre los transportes de Fira, no sobre este
código: un test que lo afirmara se pondría rojo cada vez que alguien libera algo,
y un test que se pone rojo por motivos ajenos enseña al equipo a ignorar los
rojos.

Se afirma el **contrato**: que un veredicto es uno de los valores conocidos, que
la ausencia se reporta como ausencia y no como error, que un sistema inalcanzable
falla ruidosamente, y que nada se descarta en silencio.

## Caminos que no se ejercitan, y por qué

Liberar una orden es irreversible y la mete en la cola de importación; capturar
un debuggee requiere que alguien dispare código a mano; abapGit necesita un
componente que DS4 no tiene. De esos se prueban las **guardas**: las negativas y
la calidad del mensaje cuando la respuesta es "no".

No es un premio de consolación. Cada una de esas rutas existe porque el original
devolvía algo engañoso, y una negativa equivocada cuesta tanto tiempo a un
desarrollador como un éxito equivocado.

## Escrituras en SAP

Solo `includeLifecycle` escribe. Crea `ZZFIRA_T_INC` en `$TMP` y lo borra en
`afterAll`, también tras un fallo — un include bloqueado y huérfano bloquearía la
siguiente ejecución.
