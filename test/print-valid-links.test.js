import assert from 'node:assert/strict';

process.env.FRONTEND_SUCCESS_URL = 'https://example.com/payment/success';
process.env.FRONTEND_FAILURE_URL = 'https://example.com/payment/failure';
process.env.FRONTEND_PENDING_URL = 'https://example.com/payment/pending';

const { createApp } = await import('../src/app.js');

async function createPreference(baseUrl, index) {
  const response = await fetch(`${baseUrl}/api/payments/create-preference`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      orderId: index,
      amount: 15990 + index,
      title: `Compra Bazaar Test #${index}`,
      description: 'Prueba de generacion de checkout URL',
      currency: 'ARS',
      payerEmail: 'test_user_679766592878821193@testuser.com',
      externalReference: `test-order-${index}`,
      items: [
        {
          title: `Producto test #${index}`,
          description: 'Item de prueba para checkout',
          quantity: 1,
          unit_price: 15990 + index,
          currency_id: 'ARS',
        },
      ],
    }),
  });

  const body = await response.json();

  assert.equal(
    response.status,
    201,
    `La API no devolvio 201 en intento ${index}. Respuesta: ${JSON.stringify(body)}`
  );

  assert.ok(body.checkoutUrl, `Falta checkoutUrl en intento ${index}`);
  assert.ok(
    body.checkoutUrl.includes('mercadopago.com'),
    `checkoutUrl invalida en intento ${index}: ${body.checkoutUrl}`
  );

  return body;
}

async function main() {
  const app = createApp();
  const server = app.listen(0);

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const first = await createPreference(baseUrl, 1);
    const second = await createPreference(baseUrl, 2);

    console.log('Link 1:', first.checkoutUrl);
    console.log('Link 2:', second.checkoutUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

//expo se encarga de todo 

// expo notifications o firebase notifications o algo asi para 
// enviar notificaciones push a los usuarios cuando el pago se complete,
// asi pueden recibir una notificacion en su telefono o 
// computadora sin tener que revisar su correo electronico.