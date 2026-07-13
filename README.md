# payment-service

procesamiento de pagos

POST /bookings/{id}/payment: Iniciar el cobro de una reserva (genera la preferencia/orden de pago en MercadoPago; devuelve al cliente lo necesario para completar el checkout con el SDK).

GET /bookings/{id}/payment: Consultar el estado del pago asociado a una reserva (pending, approved, rejected, refunded).

POST /payments/webhooks/mercadopago: Endpoint receptor de las notificaciones de MercadoPago; al recibir un aviso, confirma el estado real contra la API de MercadoPago y actualiza la transacción.

POST /payments/{id}/refund: Iniciar el reembolso de un pago ya confirmado (disparado por una cancelación dentro de la política permitida).

GET /users/{id}/settlements: Consultar el historial de liquidaciones de un propietario (montos acreditados por período, comisión retenida).

GET /users/{id}/settlements/{id}: Obtener el detalle de una liquidación específica (qué reservas la componen).
