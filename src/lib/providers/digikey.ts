import { ProviderPriceResult, ProviderRequest, PriceBreak } from './index';

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

export async function fetchDigiKeyPrice({ mpn, quantity, currency, packagingPreference }: ProviderRequest): Promise<ProviderPriceResult> {
  const clientId = process.env.DIGIKEY_CLIENT_ID;
  const clientSecret = process.env.DIGIKEY_CLIENT_SECRET;

  const provider = "DigiKey";

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

    // Step 3: Call V4 keyword search
    const useSandbox = process.env.DIGIKEY_USE_SANDBOX === 'true';
    const searchUrl = useSandbox
      ? 'https://sandbox-api.digikey.com/products/v4/search/keyword'
      : 'https://api.digikey.com/products/v4/search/keyword';

    const requestBody = {
      Keywords: mpn,
      Limit: 5, // Increased to get packaging options and alternate parts
      Offset: 0,
    };

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

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[${provider}] API error response:`, errBody);
      throw new Error(`API returned status ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    
    // Choose product based on packaging preference
    let product = data?.Products?.[0];
    let matchedProductIndex = 0;

    if (Array.isArray(data?.Products) && data.Products.length > 1 && packagingPreference && packagingPreference !== 'Any') {
      for (let i = 0; i < data.Products.length; i++) {
        const prod = data.Products[i];
        const packagingVal = String(prod.Packaging?.Value || prod.Packaging?.value || '').toLowerCase();
        const descVal = String(prod.ProductDescription || prod.Description || '').toLowerCase();

        const isReel = packagingVal.includes('reel') || packagingVal.includes('tr') || descVal.includes('tape & reel') || descVal.includes('reel');
        const isCutTape = packagingVal.includes('cut tape') || packagingVal.includes('ct') || packagingVal.includes('strip') || packagingVal.includes('bag') || packagingVal.includes('tube') || packagingVal.includes('tray') || packagingVal.includes('bulk');

        if (packagingPreference === 'Reel' && isReel) {
          product = prod;
          matchedProductIndex = i;
          break;
        } else if (packagingPreference === 'Cut Tape' && isCutTape) {
          product = prod;
          matchedProductIndex = i;
          break;
        }
      }
    }

    if (!product) {
      return { provider, unitPrice: null, totalCost: null, availability: 0, error: "Part not found" };
    }

    // Extract pricing details
    const priceBreaks = product?.StandardPricing || product?.ProductVariations?.[0]?.StandardPricing || [];

    const moq = product.MinimumOrderQuantity || 
                product.MinimumOrderQty || 
                product.MinOrderQuantity || 
                product.StandardPricing?.[0]?.BreakQuantity || 
                product.ProductVariations?.[0]?.MinimumOrderQuantity || 
                product.ProductVariations?.[0]?.StandardPricing?.[0]?.BreakQuantity || 
                1;

    const evalQty = Math.max(quantity, moq);

    let unitPrice = 0;
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
    }

    // Robust stock availability checking
    const qtyAvailable = product.QuantityAvailable !== undefined ? product.QuantityAvailable : null;
    const qtyOnHand = product.QuantityOnHand !== undefined ? product.QuantityOnHand : null;
    
    let availability = 0;
    if (qtyAvailable !== null && qtyAvailable > 0) {
      availability = qtyAvailable;
    } else if (qtyAvailable === 0) {
      availability = 0;
    } else if (qtyOnHand !== null && qtyOnHand > 0) {
      availability = qtyOnHand;
    }

    // Map all price breaks
    const mappedBreaks: PriceBreak[] = priceBreaks.map((pb: any) => ({
      quantity: pb.BreakQuantity || pb.breakQuantity || 0,
      price: pb.UnitPrice || pb.unitPrice || 0
    })).filter((b: any) => b.quantity > 0 && b.price > 0);

    // Dynamic alias parts gathering
    const alternatePartsSet = new Set<string>();
    
    // 1. Matched product's alternate packaging
    if (product.AlternatePackaging && Array.isArray(product.AlternatePackaging)) {
      product.AlternatePackaging.forEach((ap: any) => {
        const altMpn = ap.ManufacturerPartNumber || ap.manufacturerPartNumber;
        if (altMpn && altMpn.trim() !== product.ManufacturerPartNumber?.trim()) {
          alternatePartsSet.add(altMpn.trim());
        }
      });
    }

    // 2. Other product MPNs returned in search
    if (Array.isArray(data?.Products)) {
      data.Products.forEach((prod: any, idx: number) => {
        if (idx !== matchedProductIndex) {
          const altMpn = prod.ManufacturerPartNumber || prod.manufacturerPartNumber;
          if (altMpn && altMpn.trim() !== product.ManufacturerPartNumber?.trim()) {
            alternatePartsSet.add(altMpn.trim());
          }
        }
      });
    }

    const alternateParts = Array.from(alternatePartsSet);
    const description = product.ProductDescription || product.Description || "";
    const packaging = product.Packaging?.Value || product.Packaging?.value || "";

    return {
      provider,
      unitPrice,
      totalCost: parseFloat((unitPrice * evalQty).toFixed(3)),
      availability,
      moq,
      alternateParts,
      priceBreaks: mappedBreaks,
      description,
      packaging,
    };
  } catch (e: any) {
    console.error(`[${provider}] Error fetching part ${mpn}:`, e.message || e);
    return { provider, unitPrice: null, totalCost: null, availability: null, error: e.message || "API Error" };
  }
}
