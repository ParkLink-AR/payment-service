# payment-service

Microservicio en Node.js para crear pagos con Mercado Pago, redirigir al checkout oficial y persistir en PostgreSQL las transacciones aprobadas.

## Requisitos

- Node.js 20+ (recomendado)
- npm 10+
- PostgreSQL 14+ (local o remoto)
- Cuenta de Mercado Pago Developers con Access Token de backend

## Caracteristicas

- Crea preferencias de pago con un monto especifico.
- Retorna `checkoutUrl` para redirigir al usuario a Mercado Pago.
- Recibe webhook de Mercado Pago.
- Guarda en base de datos los pagos en estado `approved`.
- Expone endpoint para consultar una transaccion por `paymentId`.

## Instalar dependencias

Desde esta carpeta (`payment-service`):

```bash
npm install
```

Nota: este servicio es Node.js, no usa `requirements.txt`.

## Configurar un .env valido

Copiar `.env.example` a `.env` y completar:

```bash
cp .env.example .env
```

Variables importantes:

- `MERCADOPAGO_ACCESS_TOKEN`: Access Token de backend de Mercado Pago.
- `MERCADOPAGO_WEBHOOK_SECRET`: Secret de firma del webhook de Mercado Pago.
- `MP_FORCE_TEST_PAYER_EMAIL`: Mail de prueba para compras de Mercado Pago.
- `DATABASE_URL`: conexion a PostgreSQL.
- `APP_BASE_URL`: URL base del servicio.
- `WEBHOOK_BASE_URL`: URL publica del servicio para webhooks.
- `FRONTEND_SUCCESS_URL`, `FRONTEND_FAILURE_URL`, `FRONTEND_PENDING_URL`: URLs de retorno.

### Buscar mail de prueba

curl -X POST \
  'https://api.mercadopago.com/users/test_user' \
  -H 'Authorization: Bearer TU_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "site_id": "MLA"
  }'

Ejemplo minimo:

```dotenv
PORT=8004
DATABASE_URL=postgresql://user_payment:pass_payment@localhost:5434/payment_db
MERCADOPAGO_ACCESS_TOKEN=APP_USR-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MERCADOPAGO_WEBHOOK_SECRET=REEMPLAZAR_CON_LA_SECRET_DE_MERCADO_PAGO
MP_FORCE_TEST_PAYER_EMAIL = test_user.....@testuser.com
APP_BASE_URL=http://localhost:8004
WEBHOOK_BASE_URL=http://localhost:8004
FRONTEND_SUCCESS_URL=https://example.com/payment/success
FRONTEND_FAILURE_URL=https://example.com/payment/failure
FRONTEND_PENDING_URL=https://example.com/payment/pending
DEFAULT_CURRENCY=ARS
```

Importante:

- No uses Public Key en backend.
- El Access Token debe salir de Mercado Pago Developers.
- Para pruebas, usa credenciales de TEST.

## Ejecutar en local

```bash
npm run dev
```

Servidor por defecto: `http://localhost:8004`

Si no usas `nodemon`, tambien puedes correr:

```bash
npm start
```

## Ejecutar con Docker

```bash
docker compose -f compose.yaml up --build
```

## Probar la API manualmente

### Crear preferencia

```bash
curl -X POST http://localhost:8004/api/payments/create-preference \
	-H "Content-Type: application/json" \
	-d '{
		"amount": 15990,
		"title": "Compra Bazaar",
		"description": "Pago pedido #123",
		"currency": "ARS",
		"payerEmail": "test_user_679766592878821193@testuser.com"
	}'
```

Si todo esta bien, la respuesta trae `checkoutUrl`.

## Ejecutar pruebas

Para correr toda la suite de pruebas unitarias (con reporte de cobertura de código), ejecuta:

```bash
npm run test
```

Esto ejecutará las pruebas configuradas en Jest para los endpoints, base de datos e integración con MercadoPago.
Si quieres correr las pruebas sin el reporte de cobertura, puedes usar:

```bash
npx jest
```

### Prueba de validación de links

Este repo también incluye un script manual que crea 2 preferencias y muestra 2 links válidos en pantalla.

```bash
npm run test:links
```

Salida esperada (ejemplo):

```text
Link 1: https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=...
Link 2: https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=...
```

Si falla con errores de autorización o `back_url.success`:

- Revisa que `MERCADOPAGO_ACCESS_TOKEN` sea válido.
- Usa URLs `https` para `FRONTEND_SUCCESS_URL`, `FRONTEND_FAILURE_URL`, `FRONTEND_PENDING_URL`.

## Endpoints

### 1) Crear preferencia de pago

`POST /api/payments/create-preference`

Body de ejemplo:

```json
{
	"amount": 15990,
	"title": "Compra Bazaar",
	"description": "Pago pedido #123",
	"currency": "ARS",
	"payerEmail": "cliente@email.com"
}
```

Respuesta:

```json
{
	"preferenceId": "123456789-xxxx",
	"checkoutUrl": "https://www.mercadopago.com.ar/checkout/v1/redirect?...",
	"sandboxCheckoutUrl": "https://sandbox.mercadopago.com/...",
	"externalReference": "uuid"
}
```

Con `checkoutUrl` rediriges al usuario al flujo de pago de Mercado Pago.

### 2) Webhook de Mercado Pago

`POST /api/payments/webhook`

Mercado Pago llamara este endpoint cuando cambie el estado del pago. El servicio consulta el pago por API y si el estado es `approved`, guarda la transaccion en PostgreSQL.

### 3) Consultar transaccion guardada

`GET /api/payments/:paymentId`

Devuelve la transaccion persistida si fue aprobada y almacenada.

## Esquema de tabla

La tabla `transactions` se crea automaticamente al iniciar el servicio.

Campos principales:

- `payment_id` (unico)
- `amount`
- `currency`
- `status`
- `payer_email`
- `raw_payload`
- `approved_at`

## Flujo resumido

1. Tu frontend llama `create-preference` con el monto.
2. Recibe `checkoutUrl` y redirige al usuario a Mercado Pago.
3. Usuario paga en Mercado Pago.
4. Mercado Pago notifica a `webhook`.
5. Si `approved`, se guarda transaccion en DB.