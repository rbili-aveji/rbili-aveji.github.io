/* ═══════════════════════════════════════════════════════════════
   რბილი AvEji — Cloudflare Worker
   BOG Payment / Installment Integration

   Environment Variables (Cloudflare Dashboard → Settings → Variables):
     BOG_CLIENT_ID      → BOG-ისგან მიღებული Client ID
     BOG_CLIENT_SECRET  → BOG-ისგან მიღებული Client Secret

   KV Namespace Binding (Cloudflare Dashboard → Settings → Bindings):
     Variable name: KV   → შენი KV namespace
═══════════════════════════════════════════════════════════════ */

/* ─── BOG API URLs ─────────────────────────────────────────── */
const BOG_TOKEN_URL = 'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token';
const BOG_ORDER_URL = 'https://api.bog.ge/payments/v1/ecommerce/orders';

/* ─── შენი საიტის URL ─────────────────────────────────────── */
const SITE_URL = 'https://rbili-aveji.github.io';

/* ─── BOG-ის Public Key (Callback Signature ვერიფიკაციისთვის) */
const BOG_PUBLIC_KEY_PEM = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu4RUyAw3+CdkS3ZNILQh
zHI9Hemo+vKB9U2BSabppkKjzjjkf+0Sm76hSMiu/HFtYhqWOESryoCDJoqffY0Q
1VNt25aTxbj068QNUtnxQ7KQVLA+pG0smf+EBWlS1vBEAFbIas9d8c9b9sSEkTrr
TYQ90WIM8bGB6S/KLVoT1a7SnzabjoLc5Qf/SLDG5fu8dH8zckyeYKdRKSBJKvhx
tcBuHV4f7qsynQT+f2UYbESX/TLHwT5qFWZDHZ0YUOUIvb8n7JujVSGZO9/+ll/g
4ZIWhC1MlJgPObDwRkRd8NFOopgxMcMsDIZIoLbWKhHVq67hdbwpAq9K9WMmEhPn
PwIDAQAB`;

/* ─── CORS Headers ─────────────────────────────────────────── */
const CORS = {
  'Access-Control-Allow-Origin': SITE_URL,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* ══════════════════════════════════════════════════════════════
   HELPER: BOG Access Token მიღება
══════════════════════════════════════════════════════════════ */
async function getBOGToken(env) {
  const res = await fetch(BOG_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     env.BOG_CLIENT_ID,
      client_secret: env.BOG_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`BOG Token Error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

/* ══════════════════════════════════════════════════════════════
   HELPER: BOG Order შექმნა
══════════════════════════════════════════════════════════════ */
async function createBOGOrder(token, { amount, productId, productName }, workerUrl, env) {
  /* უნიკალური შიდა ID — KV-შია შენახული */
  const externalOrderId = crypto.randomUUID();

  const orderBody = {
    callback_url: `${workerUrl}/callback`,
    external_order_id: externalOrderId,
    purchase_units: [
      {
        currency: 'GEL',
        total_amount: amount,
        basket: [
          {
            quantity:    1,
            unit_price:  amount,
            product_id:  String(productId),
            description: productName,
          },
        ],
      },
    ],
    redirect_urls: {
      success: `${SITE_URL}/success.html?order=${externalOrderId}`,
      fail:    `${SITE_URL}/fail.html?order=${externalOrderId}`,
    },
  };

  const res = await fetch(BOG_ORDER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(orderBody),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`BOG Order Error ${res.status}: ${err}`);
  }

  const data = await res.json();

  /* KV-ში ვინახავთ შეკვეთის ინფორმაციას */
  await env.KV.put(
    `order:${externalOrderId}`,
    JSON.stringify({
      externalOrderId,
      bogOrderId:  data.id,
      amount,
      productName,
      status:      'pending',
      createdAt:   new Date().toISOString(),
      updatedAt:   null,
    }),
    { expirationTtl: 60 * 60 * 24 * 90 } /* 90 დღე */
  );

  /* BOG redirect URL */
  return {
    externalOrderId,
    redirectUrl: data._links?.redirect?.href,
  };
}

/* ══════════════════════════════════════════════════════════════
   HELPER: BOG Callback Signature ვერიფიკაცია
   SHA256withRSA — BOG Public Key-ით
══════════════════════════════════════════════════════════════ */
async function verifyBOGSignature(payloadText, signatureBase64) {
  try {
    /* PEM → binary */
    const cleaned = BOG_PUBLIC_KEY_PEM.replace(/\s/g, '');
    const binary  = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'spki',
      binary.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes     = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const payloadBytes = new TextEncoder().encode(payloadText);

    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      sigBytes,
      payloadBytes
    );
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   MAIN HANDLER
══════════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    /* ── CORS Preflight ── */
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* ════════════════════════════════════════════
       POST /create-order
       Frontend → Worker: შეკვეთა შექმნა
    ════════════════════════════════════════════ */
    if (path === '/create-order' && method === 'POST') {
      try {
        const body = await request.json();

        /* Validation */
        const { amount, productId, productName } = body;
        if (!amount || !productId || !productName) {
          return Response.json(
            { error: 'Missing required fields: amount, productId, productName' },
            { status: 400, headers: CORS }
          );
        }
        if (typeof amount !== 'number' || amount <= 0) {
          return Response.json(
            { error: 'Invalid amount' },
            { status: 400, headers: CORS }
          );
        }

        /* Worker-ის საკუთარი URL (callback-ისთვის) */
        const workerUrl = `${url.protocol}//${url.host}`;

        /* Token + Order */
        const token  = await getBOGToken(env);
        const result = await createBOGOrder(token, { amount, productId, productName }, workerUrl, env);

        return Response.json(result, { headers: CORS });

      } catch (err) {
        console.error('create-order error:', err.message);
        return Response.json(
          { error: 'შეკვეთის შექმნა ვერ მოხერხდა. სცადეთ მოგვიანებით.' },
          { status: 500, headers: CORS }
        );
      }
    }

    /* ════════════════════════════════════════════
       POST /callback
       BOG → Worker: გადახდის სტატუსი (Webhook)
       სავალდებულო: HTTP 200 უნდა დავაბრუნოთ
    ════════════════════════════════════════════ */
    if (path === '/callback' && method === 'POST') {
      let payloadText = '';
      try {
        payloadText = await request.text();

        /* 1. Signature შემოწმება */
        const signature = request.headers.get('Callback-Signature');
        if (!signature) {
          console.error('Callback: Missing Callback-Signature header');
          /* მაინც 200, რათა BOG არ იმეოროს */
          return new Response('OK', { status: 200 });
        }

        const isValid = await verifyBOGSignature(payloadText, signature);
        if (!isValid) {
          console.error('Callback: Invalid signature — ignoring');
          return new Response('OK', { status: 200 });
        }

        /* 2. Payload დამუშავება */
        const data            = JSON.parse(payloadText);
        const externalOrderId = data.external_order_id;
        const bogStatus       = data.order_status?.key || 'unknown';

        if (externalOrderId) {
          const stored = await env.KV.get(`order:${externalOrderId}`);
          if (stored) {
            const order     = JSON.parse(stored);
            order.status    = bogStatus;        /* completed / rejected / refunded… */
            order.bogStatus = data.order_status;
            order.updatedAt = new Date().toISOString();
            await env.KV.put(
              `order:${externalOrderId}`,
              JSON.stringify(order),
              { expirationTtl: 60 * 60 * 24 * 90 }
            );
            console.log(`Order ${externalOrderId} → ${bogStatus}`);
          }
        }

        /* 3. BOG-ს სავალდებულო HTTP 200 */
        return new Response('OK', { status: 200 });

      } catch (err) {
        console.error('Callback error:', err.message);
        /* შეცდომის შემთხვევაშიც 200 ვაბრუნებთ */
        return new Response('OK', { status: 200 });
      }
    }

    /* ════════════════════════════════════════════
       GET /status/:orderId
       success.html / fail.html → Worker: სტატუსი
    ════════════════════════════════════════════ */
    if (path.startsWith('/status/') && method === 'GET') {
      const orderId = path.replace('/status/', '').trim();
      if (!orderId) {
        return Response.json({ error: 'Missing orderId' }, { status: 400, headers: CORS });
      }

      const stored = await env.KV.get(`order:${orderId}`);
      if (!stored) {
        return Response.json({ error: 'Order not found' }, { status: 404, headers: CORS });
      }

      /* მომხმარებელს მხოლოდ საჭირო ველებს ვაჩვენებთ */
      const order = JSON.parse(stored);
      return Response.json(
        {
          status:      order.status,
          amount:      order.amount,
          productName: order.productName,
          createdAt:   order.createdAt,
        },
        { headers: CORS }
      );
    }

    /* ── 404 ── */
    return new Response('Not Found', { status: 404 });
  },
};
