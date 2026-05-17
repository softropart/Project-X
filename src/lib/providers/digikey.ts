import { ProviderPriceResult, ProviderRequest } from './index';

// Simple in-memory token cache
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    // console.log('[DigiKey] Using cached OAuth token');
    return cachedToken.token;
  }

  const useSandbox = process.env.DIGIKEY_USE_SANDBOX === 'true';
  const tokenUrl = useSandbox 
    ? 'https://sandbox-api.digikey.com/v1/oauth2/token'
    : 'https://api.digikey.com/v1/oauth2/token';

  // console.log(`[DigiKey] Requesting OAuth token from ${useSandbox ? 'SANDBOX' : 'PRODUCTION'}`);
  // console.log(`[DigiKey] Token URL: ${tokenUrl}`);

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[DigiKey] OAuth token request failed (${res.status}): ${errText}`);
    throw new Error(`OAuth token request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresIn = data.expires_in || 600; // default 10 min

  // console.log(`[DigiKey] OAuth token obtained successfully, expires in ${expiresIn}s`);

  cachedToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return token;
}

export async function fetchDigiKeyPrice({ mpn, quantity, currency }: ProviderRequest): Promise<ProviderPriceResult> {
  const clientId = process.env.DIGIKEY_CLIENT_ID;
  const clientSecret = process.env.DIGIKEY_CLIENT_SECRET;

  const provider = "DigiKey";

  // console.log(`[${provider}] ========================================`);
  // console.log(`[${provider}] Fetching part: ${mpn}`);
  // console.log(`[${provider}] Quantity: ${quantity}, Currency: ${currency}`);

  if (!clientId || !clientSecret) {
    console.error(`[${provider}] API credentials missing.`);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: "Credentials missing" };
  }

  try {
    // Step 1: Get OAuth2 access token (2-legged client_credentials flow)
    const accessToken = await getAccessToken(clientId, clientSecret);

    // Step 2: Locale mapping
    const localeSite = currency === 'INR' ? 'IN' : currency === 'EUR' ? 'DE' : 'US';
    const localeLanguage = 'en';

    // console.log(`[${provider}] Locale: Site=${localeSite}, Language=${localeLanguage}, Currency=${currency}`);

    // Step 3: Call V4 keyword search
    const useSandbox = process.env.DIGIKEY_USE_SANDBOX === 'true';
    const searchUrl = useSandbox
      ? 'https://sandbox-api.digikey.com/products/v4/search/keyword'
      : 'https://api.digikey.com/products/v4/search/keyword';

    // console.log(`[${provider}] Search URL (${useSandbox ? 'SANDBOX' : 'PRODUCTION'}): ${searchUrl}`);

    const requestBody = {
      Keywords: mpn,
      Limit: 1,
      Offset: 0,
    };

    // console.log(`[${provider}] Request body:`, JSON.stringify(requestBody, null, 2));

    const res = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-DIGIKEY-Client-Id': clientId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-DIGIKEY-Locale-Site': localeSite,
        'X-DIGIKEY-Locale-Language': localeLanguage,
        'X-DIGIKEY-Locale-Currency': currency,
        'X-DIGIKEY-Customer-Id': '0',
      },
      body: JSON.stringify(requestBody),
    });

    // console.log(`[${provider}] Response status: ${res.status}`);

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[${provider}] API error response:`, errBody);
      throw new Error(`API returned status ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    // console.log(`[${provider}] Response data:`, JSON.stringify(data, null, 2));

    // V4 response structure: data.Products is an array
    const product = data?.Products?.[0];

    if (!product) {
      // console.log(`[${provider}] Part not found in response`);
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    // console.log(`[${provider}] Product found: ${product.ManufacturerPartNumber || product.DigiKeyPartNumber}`);

    // Extract unit price from the StandardPricing price breaks
    let unitPrice = 0;
    const priceBreaks = product?.StandardPricing || product?.ProductVariations?.[0]?.StandardPricing || [];
    
    // console.log(`[${provider}] Price breaks:`, JSON.stringify(priceBreaks, null, 2));

    const moq = product.MinimumOrderQuantity || product.StandardPricing?.[0]?.BreakQuantity || 1;
    const evalQty = Math.max(quantity, moq);

    const sortedBreaks = [...priceBreaks].sort((a, b) => (a.BreakQuantity || 0) - (b.BreakQuantity || 0));
    for (const pb of sortedBreaks) {
      const breakQty = pb.BreakQuantity || 0;
      const price = pb.UnitPrice || 0;
      if (breakQty <= evalQty && price > 0) {
        unitPrice = price;
      }
    }
    // Fallback: try UnitPrice directly on product
    if (unitPrice === 0 && product.UnitPrice) {
      unitPrice = product.UnitPrice;
      // console.log(`[${provider}] Using direct UnitPrice: ${unitPrice}`);
    }

    const availability = product.QuantityAvailable || product.QuantityOnHand || 0;

    // console.log(`[${provider}] Final result: unitPrice=${unitPrice}, totalCost=${unitPrice * quantity}, availability=${availability}`);
    // console.log(`[${provider}] ========================================`);


    const alternateParts: string[] = [];
    if (Array.isArray(product.AlternatePackaging)) {
      product.AlternatePackaging.forEach((ap: any) => {
        if (ap.ManufacturerPartNumber) alternateParts.push(ap.ManufacturerPartNumber);
      });
    }

    return {
      provider,
      unitPrice,
      totalCost: parseFloat((unitPrice * evalQty).toFixed(3)),
      availability,
      moq,
      alternateParts,
    };
  } catch (e: any) {
    console.error(`[${provider}] Error fetching part ${mpn}:`, e.message || e);
    // console.error(`[${provider}] Stack trace:`, e.stack);
    // console.log(`[${provider}] ========================================`);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: e.message || "API Error" };
  }
}
